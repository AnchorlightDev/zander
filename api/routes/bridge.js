import { isFeatureEnabled, optional } from "../common.js";

const BASE_ENDPOINT = "/api/bridge";
const TASK_TABLE = "executorTasks";
const ROUTINE_TABLE = "executorRoutines";
const ROUTINE_STEPS_TABLE = "executorRoutineSteps";

const VALID_STATUSES = ["pending", "processing", "completed", "failed"];

function normalizeCommand(command) {
  if (typeof command !== "string") {
    return "";
  }

  return command.trim().replace(/^\/+/, "").trim();
}

function toMetadataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value;
}

function mergeMetadata(...sources) {
  const merged = {};
  let hasEntries = false;

  sources.forEach((source) => {
    const metadata = toMetadataObject(source);
    if (!metadata) {
      return;
    }

    Object.entries(metadata).forEach(([key, value]) => {
      merged[key] = value;
      hasEntries = true;
    });
  });

  return hasEntries ? merged : null;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyMetadataPlaceholders(command, ...metadataSources) {
  let resolved = typeof command === "string" ? command : "";

  const mergedMetadata = mergeMetadata(...metadataSources);
  if (!mergedMetadata) {
    return resolved;
  }

  Object.entries(mergedMetadata).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }

    const replacement = typeof value === "string" ? value : String(value);
    const escapedKey = escapeRegExp(key);
    // Double-brace syntax: {{key}} or {{ key }}
    resolved = resolved.replace(new RegExp(`{{\\s*${escapedKey}\\s*}}`, "gi"), replacement);
    // Single-brace syntax: {key} — only when not part of a double-brace sequence
    resolved = resolved.replace(new RegExp(`(?<!\\{)\\{\\s*${escapedKey}\\s*\\}(?!\\})`, "gi"), replacement);
  });

  return resolved;
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return ["true", "1", "yes", "y"].includes(normalized);
  }

  return false;
}

function safeJsonParse(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

export default function bridgeApiRoute(app, config, db, features, lang) {
  function query(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.query(sql, params, (error, results) => {
        if (error) return reject(error);
        return resolve(results);
      });
    });
  }

  function hydrateTasks(rows) {
    return rows.map((row) => ({
      executorTaskId: row.executorTaskId,
      slug: row.slug,
      command: row.command,
      status: row.status,
      routineSlug: row.routineSlug,
      metadata: safeJsonParse(row.metadata),
      result: row.result,
      priority: row.priority,
      executedBy: row.executedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      processedAt: row.processedAt,
    }));
  }

  app.get(`${BASE_ENDPOINT}/processor/get`, async function (req, res) {
    if (!isFeatureEnabled(features.bridge, res, lang)) return;

    const slug = optional(req.query, "slug");
    const status = (optional(req.query, "status") || "pending").toLowerCase();
    const limitValue = optional(req.query, "limit");
    const claim = toBoolean(optional(req.query, "claim"));

    if (!VALID_STATUSES.includes(status)) {
      return res.send({
        success: false,
        message: `Invalid status '${status}'. Allowed values: ${VALID_STATUSES.join(", ")}`,
      });
    }

    let limit = 50;
    if (limitValue !== null && !Number.isNaN(Number(limitValue))) {
      limit = Math.max(1, Math.min(Number(limitValue), 250));
    }

    try {
      const params = [status];
      let sql = `SELECT * FROM ${TASK_TABLE} WHERE status = ?`;

      if (slug) {
        // Match tasks targeting this specific server OR tasks marked 'any'
        // (claimable by whichever server polls first).
        sql += ` AND (slug = ? OR slug = 'any')`;
        params.push(slug);
      }

      sql += ` ORDER BY priority DESC, executorTaskId ASC LIMIT ?`;
      params.push(limit);

      const rows = await query(sql, params);
      const tasks = hydrateTasks(rows);

      if (claim && tasks.length > 0) {
        const ids = tasks.map((task) => task.executorTaskId);
        const placeholders = ids.map(() => "?").join(",");
        await query(
          `UPDATE ${TASK_TABLE} SET status = 'processing', updatedAt = NOW() WHERE executorTaskId IN (${placeholders}) AND status = 'pending'`,
          ids
        );

        tasks.forEach((task) => {
          if (task.status === "pending") {
            task.status = "processing";
            task.updatedAt = new Date();
          }
        });
      }

      return res.send({
        success: true,
        data: tasks,
        meta: {
          status,
          claimed: claim,
          count: tasks.length,
        },
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(`${BASE_ENDPOINT}/processor/command/add`, async function (req, res) {
    if (!isFeatureEnabled(features.bridge, res, lang)) return;

    const inlineCommand = optional(req.body, "command");
    const inlineSlug = optional(req.body, "slug") || optional(req.body, "target");
    const routineSlug = optional(req.body, "routineSlug");
    const tasksPayload = optional(req.body, "tasks");
    const metadata = optional(req.body, "metadata");
    const priority = Number(optional(req.body, "priority")) || 0;

    if (!inlineCommand && !routineSlug && !Array.isArray(tasksPayload)) {
      return res.send({
        success: false,
        message: `A command, routineSlug, or tasks array is required to add to the processor`,
      });
    }

    try {
      const tasksToInsert = [];

      const rootMetadata = toMetadataObject(metadata);

      if (inlineCommand) {
        if (!inlineSlug) {
          return res.send({
            success: false,
            message: `When providing a single command you must include a slug or target`,
          });
        }

        const resolvedCommand = normalizeCommand(
          applyMetadataPlaceholders(inlineCommand, rootMetadata)
        );

        if (!resolvedCommand) {
          return res.send({
            success: false,
            message: `Command must contain text after removing leading slashes`,
          });
        }

        tasksToInsert.push({
          slug: inlineSlug,
          command: resolvedCommand,
          metadata: rootMetadata || null,
          priority,
          routineSlug: null,
        });
      }

      if (Array.isArray(tasksPayload) && tasksPayload.length > 0) {
        tasksPayload.forEach((task, index) => {
          if (!task || typeof task !== "object") {
            throw new Error(`Task payload at index ${index} must be an object`);
          }

          if (!task.command) {
            throw new Error(`Task payload at index ${index} is missing 'command'`);
          }

          const taskSlug = task.slug || task.target || inlineSlug;
          if (!taskSlug) {
            throw new Error(`Task payload at index ${index} is missing 'slug'`);
          }

          const stepMetadata = toMetadataObject(task.metadata);
          const combinedMetadata = mergeMetadata(rootMetadata, stepMetadata);
          const resolvedCommand = normalizeCommand(
            applyMetadataPlaceholders(task.command, rootMetadata, stepMetadata)
          );

          if (!resolvedCommand) {
            throw new Error(
              `Task payload at index ${index} must include a command after removing leading slashes`
            );
          }

          tasksToInsert.push({
            slug: taskSlug,
            command: resolvedCommand,
            metadata: combinedMetadata,
            priority: Number(task.priority ?? priority) || 0,
            routineSlug: task.routineSlug || null,
          });
        });
      }

      if (routineSlug) {
        const routines = await query(
          `SELECT executorRoutineId FROM ${ROUTINE_TABLE} WHERE routineSlug = ?`,
          [routineSlug]
        );

        if (!routines.length) {
          return res.send({
            success: false,
            message: `Routine '${routineSlug}' could not be found`,
          });
        }

        const routineId = routines[0].executorRoutineId;
        const routineSteps = await query(
          `SELECT slug, command, metadata, stepOrder FROM ${ROUTINE_STEPS_TABLE} WHERE executorRoutineId = ? ORDER BY stepOrder ASC`,
          [routineId]
        );

        if (!routineSteps.length) {
          return res.send({
            success: false,
            message: `Routine '${routineSlug}' does not have any steps configured`,
          });
        }

        routineSteps.forEach((step) => {
          const stepMetadata = toMetadataObject(safeJsonParse(step.metadata));
          const combinedMetadata = mergeMetadata(rootMetadata, stepMetadata);
          const resolvedCommand = normalizeCommand(
            applyMetadataPlaceholders(step.command, rootMetadata, stepMetadata)
          );

          if (!resolvedCommand) {
            return;
          }

          tasksToInsert.push({
            slug: step.slug,
            command: resolvedCommand,
            metadata: combinedMetadata,
            priority,
            routineSlug,
          });
        });
      }

      if (!tasksToInsert.length) {
        return res.send({
          success: false,
          message: `Unable to resolve any tasks to insert`,
        });
      }

      const insertedTaskIds = [];

      for (const task of tasksToInsert) {
        const params = [
          task.slug,
          task.command,
          "pending",
          task.routineSlug,
          task.metadata ? JSON.stringify(task.metadata) : null,
          task.priority,
        ];

        const result = await query(
          `INSERT INTO ${TASK_TABLE} (slug, command, status, routineSlug, metadata, priority) VALUES (?, ?, ?, ?, ?, ?)`,
          params
        );
        insertedTaskIds.push(result.insertId);
      }

      const insertedTasks = await query(
        `SELECT * FROM ${TASK_TABLE} WHERE executorTaskId IN (${insertedTaskIds
          .map(() => "?")
          .join(",")}) ORDER BY executorTaskId ASC`,
        insertedTaskIds
      );

      return res.send({
        success: true,
        message: `Queued ${insertedTaskIds.length} executor task${
          insertedTaskIds.length === 1 ? "" : "s"
        }`,
        data: hydrateTasks(insertedTasks),
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(
    `${BASE_ENDPOINT}/processor/task/:taskId/report`,
    async function (req, res) {
      if (!isFeatureEnabled(features.bridge, res, lang)) return;

      const taskId = Number(req.params.taskId);
      if (!taskId || Number.isNaN(taskId)) {
        return res.send({
          success: false,
          message: `Task ID is required to submit a report`,
        });
      }

      const statusRaw = optional(req.body, "status");
      const status = (statusRaw || "").toString().toLowerCase();
      const resultText = optional(req.body, "result");
      const executedBy = optional(req.body, "executedBy");
      const metadata = optional(req.body, "metadata");

      if (!status) {
        return res.send({
          success: false,
          message: `status is required to report task progress`,
        });
      }

      if (!VALID_STATUSES.includes(status)) {
        return res.send({
          success: false,
          message: `Invalid status '${status}'. Allowed values: ${VALID_STATUSES.join(", ")}`,
        });
      }

      try {
        const processedAtStatuses = ["completed", "failed"];
        const processedAtFragment = processedAtStatuses.includes(status)
          ? ", processedAt = NOW()"
          : "";

        await query(
          `UPDATE ${TASK_TABLE} SET status = ?, result = ?, executedBy = ?, metadata = COALESCE(?, metadata)${processedAtFragment}, updatedAt = NOW() WHERE executorTaskId = ?`,
          [
            status,
            resultText,
            executedBy,
            metadata ? JSON.stringify(metadata) : null,
            taskId,
          ]
        );

        const updatedTasks = await query(
          `SELECT * FROM ${TASK_TABLE} WHERE executorTaskId = ?`,
          [taskId]
        );

        return res.send({
          success: true,
          message: `Task ${taskId} marked as ${status}`,
          data: hydrateTasks(updatedTasks)[0] || null,
        });
      } catch (error) {
        console.error(error);
        if (!res.sent) {
          return res.status(500).send({
            success: false,
            message: `${error}`,
          });
        }
      }
    }
  );

  app.post(`${BASE_ENDPOINT}/processor/task/:taskId/reset`, async function (req, res) {
    if (!isFeatureEnabled(features.bridge, res, lang)) return;

    const taskId = Number(req.params.taskId);
    if (!taskId || Number.isNaN(taskId)) {
      return res.send({
        success: false,
        message: `Task ID is required to reset a task`,
      });
    }

    try {
      await query(
        `UPDATE ${TASK_TABLE} SET status = 'pending', result = NULL, executedBy = NULL, processedAt = NULL, updatedAt = NOW() WHERE executorTaskId = ?`,
        [taskId]
      );

      const updatedTasks = await query(
        `SELECT * FROM ${TASK_TABLE} WHERE executorTaskId = ?`,
        [taskId]
      );

      return res.send({
        success: true,
        message: `Task ${taskId} has been reset to pending`,
        data: hydrateTasks(updatedTasks)[0] || null,
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(`${BASE_ENDPOINT}/processor/clear`, async function (req, res) {
    if (!isFeatureEnabled(features.bridge, res, lang)) return;

    const statusRaw = optional(req.body, "status");
    const slug = optional(req.body, "slug") || optional(req.body, "target");
    const routineSlug = optional(req.body, "routineSlug");

    const filters = [];
    const params = [];

    if (statusRaw) {
      const normalizedStatus = statusRaw.toString().toLowerCase();
      if (!VALID_STATUSES.includes(normalizedStatus)) {
        return res.send({
          success: false,
          message: `Invalid status '${normalizedStatus}'. Allowed values: ${VALID_STATUSES.join(", ")}`,
        });
      }

      filters.push("status = ?");
      params.push(normalizedStatus);
    }

    if (slug) {
      filters.push("slug = ?");
      params.push(slug);
    }

    if (routineSlug) {
      filters.push("routineSlug = ?");
      params.push(routineSlug);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    try {
      const result = await query(
        `DELETE FROM ${TASK_TABLE} ${whereClause}`,
        params
      );

      return res.send({
        success: true,
        message: `Removed ${result.affectedRows} executor task${
          result.affectedRows === 1 ? "" : "s"
        }`,
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(`${BASE_ENDPOINT}/routine/save`, async function (req, res) {
    if (!isFeatureEnabled(features.bridge, res, lang)) return;

    const routineSlugRaw = optional(req.body, "routineSlug");
    const routineSlug = (routineSlugRaw || "").toString().trim().toLowerCase();
    const displayName = optional(req.body, "displayName");
    const description = optional(req.body, "description");
    const steps = optional(req.body, "steps");

    if (!routineSlug) {
      return res.send({
        success: false,
        message: `routineSlug is required`,
      });
    }

    if (!Array.isArray(steps) || !steps.length) {
      return res.send({
        success: false,
        message: `Routine '${routineSlug}' requires at least one step`,
      });
    }

    try {
      const normalizedSteps = steps.map((step, index) => {
        if (!step || typeof step !== "object") {
          throw new Error(`Routine step at index ${index} must be an object`);
        }

        if (!step.command) {
          throw new Error(`Routine step at index ${index} is missing 'command'`);
        }

        const stepSlug = step.slug || step.target;
        if (!stepSlug) {
          throw new Error(`Routine step at index ${index} is missing 'slug'`);
        }

        const orderValue = Number(step.order ?? index);
        const metadataObject = toMetadataObject(step.metadata);
        const sanitizedCommand = normalizeCommand(step.command);

        if (!sanitizedCommand) {
          throw new Error(
            `Routine step at index ${index} must include a command after removing leading slashes`
          );
        }

        return {
          slug: stepSlug,
          command: sanitizedCommand,
          order: Number.isFinite(orderValue) ? orderValue : index,
          metadata: metadataObject,
        };
      });

      let routineId = null;
      const existingRoutine = await query(
        `SELECT executorRoutineId FROM ${ROUTINE_TABLE} WHERE routineSlug = ?`,
        [routineSlug]
      );

      if (existingRoutine.length) {
        routineId = existingRoutine[0].executorRoutineId;
        await query(
          `UPDATE ${ROUTINE_TABLE} SET displayName = ?, description = ?, updatedAt = NOW() WHERE executorRoutineId = ?`,
          [displayName, description, routineId]
        );
        await query(
          `DELETE FROM ${ROUTINE_STEPS_TABLE} WHERE executorRoutineId = ?`,
          [routineId]
        );
      } else {
        const insertRoutine = await query(
          `INSERT INTO ${ROUTINE_TABLE} (routineSlug, displayName, description) VALUES (?, ?, ?)`,
          [routineSlug, displayName, description]
        );
        routineId = insertRoutine.insertId;
      }

      for (const step of normalizedSteps) {
        await query(
          `INSERT INTO ${ROUTINE_STEPS_TABLE} (executorRoutineId, stepOrder, slug, command, metadata) VALUES (?, ?, ?, ?, ?)`,
          [
            routineId,
            step.order,
            step.slug,
            step.command,
            step.metadata ? JSON.stringify(step.metadata) : null,
          ]
        );
      }

      const routineSteps = await query(
        `SELECT slug, command, metadata, stepOrder FROM ${ROUTINE_STEPS_TABLE} WHERE executorRoutineId = ? ORDER BY stepOrder ASC`,
        [routineId]
      );

      return res.send({
        success: true,
        message: `Routine '${routineSlug}' saved with ${routineSteps.length} step${
          routineSteps.length === 1 ? "" : "s"
        }`,
        data: {
          routineSlug,
          displayName,
          description,
          steps: routineSteps.map((step) => ({
            slug: step.slug,
            command: step.command,
            order: step.stepOrder,
            metadata: safeJsonParse(step.metadata),
          })),
        },
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.get(`${BASE_ENDPOINT}/routine/get`, async function (req, res) {
    if (!isFeatureEnabled(features.bridge, res, lang)) return;

    const routineSlug = optional(req.query, "routineSlug") || optional(req.query, "slug");

    try {
      const routineFilterParams = [];
      let routineSql = `SELECT * FROM ${ROUTINE_TABLE}`;

      if (routineSlug) {
        routineSql += ` WHERE routineSlug = ?`;
        routineFilterParams.push(routineSlug);
      }

      const routines = await query(routineSql, routineFilterParams);
      if (!routines.length) {
        return res.send({
          success: true,
          data: [],
        });
      }

      const routineIds = routines.map((routine) => routine.executorRoutineId);
      const placeholders = routineIds.map(() => "?").join(",");
      const routineSteps = await query(
        `SELECT * FROM ${ROUTINE_STEPS_TABLE} WHERE executorRoutineId IN (${placeholders}) ORDER BY executorRoutineId ASC, stepOrder ASC`,
        routineIds
      );

      const stepsByRoutine = routineSteps.reduce((acc, step) => {
        if (!acc[step.executorRoutineId]) {
          acc[step.executorRoutineId] = [];
        }

        acc[step.executorRoutineId].push({
          slug: step.slug,
          command: step.command,
          order: step.stepOrder,
          metadata: safeJsonParse(step.metadata),
        });

        return acc;
      }, {});

      const payload = routines.map((routine) => ({
        routineSlug: routine.routineSlug,
        displayName: routine.displayName,
        description: routine.description,
        createdAt: routine.createdAt,
        updatedAt: routine.updatedAt,
        steps: stepsByRoutine[routine.executorRoutineId] || [],
      }));

      return res.send({
        success: true,
        data: payload,
        meta: {
          count: payload.length,
        },
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.get(`${BASE_ENDPOINT}/server/get`, async function (req, res) {
    if (!isFeatureEnabled(features.bridge, res, lang)) return;

    try {
      const results = await query(`SELECT * FROM serverStatus;`);

      return res.send({
        success: true,
        data: results,
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(`${BASE_ENDPOINT}/server/update`, async function (req, res) {
    if (!isFeatureEnabled(features.bridge, res, lang)) return;

    const serverInfoPayload = optional(req.body, "serverInfo");
    const lastUpdatedRaw = optional(req.body, "lastUpdated");
    let lastUpdated = new Date();

    if (lastUpdatedRaw) {
      const parsedDate = new Date(lastUpdatedRaw);
      if (!isNaN(parsedDate.getTime())) {
        lastUpdated = parsedDate;
      }
    }

    if (!serverInfoPayload) {
      return res.send({
        success: false,
        message: `serverInfo is required`,
      });
    }

    let serverInfoString = serverInfoPayload;

    if (typeof serverInfoPayload === "object") {
      serverInfoString = JSON.stringify(serverInfoPayload);
    }

    if (typeof serverInfoString !== "string") {
      return res.send({
        success: false,
        message: `serverInfo must be an object or JSON string`,
      });
    }

    try {
      await query(
        `UPDATE serverStatus SET statusInfo = ?, lastUpdated = ? WHERE serverStatusId = 1;`,
        [serverInfoString, lastUpdated]
      );

      return res.send({
        success: true,
        message: `Server status updated successfully.`,
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });
}
