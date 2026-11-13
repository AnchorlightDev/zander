import { describe, it, expect } from "vitest";
import { claimPendingTasks } from "../../lib/bridgeTaskClaim.mjs";
import { moveIdInOrder } from "../../lib/hologramOrder.mjs";

describe("claimPendingTasks", () => {
  it("returns only the tasks whose conditional update this caller won", async () => {
    const tasks = [
      { executorTaskId: 1, status: "pending" },
      { executorTaskId: 2, status: "pending" },
      { executorTaskId: 3, status: "pending" },
    ];
    // Task 2 was already claimed by another server between SELECT and UPDATE.
    const claimed = await claimPendingTasks(tasks, async (id) => (id === 2 ? 0 : 1));
    expect(claimed.map((t) => t.executorTaskId)).toEqual([1, 3]);
    expect(claimed.every((t) => t.status === "processing")).toBe(true);
  });

  it("two pollers racing for the same task never both receive it", async () => {
    const state = new Map([[7, "pending"]]);
    const tryClaim = async (id) => {
      if (state.get(id) !== "pending") return 0;
      state.set(id, "processing");
      return 1;
    };
    const rows = [{ executorTaskId: 7, status: "pending" }];
    const [a, b] = await Promise.all([claimPendingTasks(rows, tryClaim), claimPendingTasks(rows, tryClaim)]);
    expect(a.length + b.length).toBe(1);
  });

  it("passes non-pending tasks through without claiming them", async () => {
    let calls = 0;
    const claimed = await claimPendingTasks(
      [{ executorTaskId: 4, status: "processing" }],
      async () => { calls += 1; return 1; }
    );
    expect(calls).toBe(0);
    expect(claimed).toEqual([{ executorTaskId: 4, status: "processing" }]);
  });
});

describe("moveIdInOrder", () => {
  it("moves a frame up even when every frame shares the same sortOrder", () => {
    expect(moveIdInOrder([10, 11, 12], 12, "up")).toEqual([10, 12, 11]);
  });

  it("moves a frame down", () => {
    expect(moveIdInOrder([10, 11, 12], 10, "down")).toEqual([11, 10, 12]);
  });

  it("returns null at the ends or for an unknown id", () => {
    expect(moveIdInOrder([10, 11], 10, "up")).toBeNull();
    expect(moveIdInOrder([10, 11], 11, "down")).toBeNull();
    expect(moveIdInOrder([10, 11], 99, "up")).toBeNull();
  });
});
