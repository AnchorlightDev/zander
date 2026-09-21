import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { v2 as cloudinary } from "cloudinary";

const configured =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

if (configured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

export function isCloudinaryConfigured() {
  return !!configured;
}

export async function uploadImage(buffer, { folder = "zander", resourceType = "image" } = {}) {
  if (!configured) throw new Error("Cloudinary is not configured");

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
        });
      }
    );
    stream.end(buffer);
  });
}

// ============================================================================
// Audio and archive assets
//
// Meeting audio lives in the same Cloudinary account as everything else — there
// is no second asset tree to manage, no second set of credentials to rotate.
// What differs is how it gets there and how it comes back out.
// ============================================================================

/** Default folder for meeting audio.  The janitor cron reconciles against it. */
export const MEETINGS_FOLDER = "zander/meetings";

/**
 * Cloudinary has no "audio" resource type — audio is uploaded, stored and
 * transformed as `video`.  Getting this wrong uploads an ogg as a raw file,
 * which then has no duration and cannot be streamed.
 */
const AUDIO_RESOURCE_TYPE = "video";

/**
 * Upload a media file by streaming it from disk.
 *
 * Deliberately NOT uploadImage(): that takes a Buffer, which is right for an
 * 8 MB banner and badly wrong for a meeting recording, where it would pull
 * hundreds of megabytes into the web app's heap — on a process that also serves
 * every request and runs the Discord bot, under --max-old-space-size=512.
 * upload_large_stream chunks it instead, so memory use stays flat regardless of
 * how long the meeting ran.
 *
 * `type: "authenticated"` is the other half of the point.  A default upload
 * gets a `secure_url` that works for anyone who has ever seen the link — fine
 * for a public banner, not for a staff meeting.  An authenticated asset is only
 * reachable through a signed URL, which the session route mints per request,
 * after the roster check.  See signedAssetUrl() below.
 *
 * @returns {{url: string, publicId: string, format: string, bytes: number, durationMs: number|null}}
 */
export async function uploadAudioFile(filePath, { folder = MEETINGS_FOLDER, publicId = null, chunkSize = 6 * 1024 * 1024 } = {}) {
  if (!configured) throw new Error("Cloudinary is not configured");

  // Fail before opening a stream, so a missing mixdown reports as a missing
  // file rather than as an upload error thirty seconds later.
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Refusing to upload an empty or non-regular file: ${filePath}`);
  }

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_large_stream(
      {
        folder,
        public_id: publicId || undefined,
        resource_type: AUDIO_RESOURCE_TYPE,
        type: "authenticated",
        chunk_size: chunkSize,
      },
      (error, result) => {
        if (error) return reject(error);
        if (!result?.public_id) return reject(new Error("Cloudinary returned no public_id"));

        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          bytes: result.bytes,
          // Cloudinary reports duration in (fractional) seconds; every offset in
          // the meetings module is milliseconds, so it is converted once here
          // rather than at each call site.
          durationMs: result.duration != null ? Math.round(result.duration * 1000) : null,
        });
      }
    );

    const source = createReadStream(filePath);
    source.on("error", reject);
    source.pipe(upload);
  });
}

/**
 * Upload an archive bundle (a zip).  `raw` rather than `video`: Cloudinary will
 * not accept a zip as media, and a raw asset is served back byte-for-byte.
 */
export async function uploadArchiveFile(filePath, { folder = MEETINGS_FOLDER, publicId = null } = {}) {
  if (!configured) throw new Error("Cloudinary is not configured");

  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Refusing to upload an empty or non-regular file: ${filePath}`);
  }

  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_large_stream(
      {
        folder,
        public_id: publicId || undefined,
        resource_type: "raw",
        type: "authenticated",
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          bytes: result.bytes,
          resourceType: "raw",
        });
      }
    );

    const source = createReadStream(filePath);
    source.on("error", reject);
    source.pipe(upload);
  });
}

/**
 * Delete an asset.
 *
 * Takes the public_id, not the URL — which is why every table in the meetings
 * module stores the id alongside the URL.  `type: "authenticated"` has to match
 * how it was uploaded, or Cloudinary reports "not found" against a
 * perfectly-present asset and the caller concludes the cleanup worked.
 */
export async function deleteAsset(publicId, { resourceType = AUDIO_RESOURCE_TYPE, type = "authenticated" } = {}) {
  if (!configured) throw new Error("Cloudinary is not configured");
  if (!publicId) throw new Error("A public_id is required to delete an asset");

  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    type,
    invalidate: true,
  });

  // "not found" is treated as success: the caller wanted the asset gone, and it
  // is.  Anything else is a real failure and is surfaced.
  if (result?.result && result.result !== "ok" && result.result !== "not found") {
    throw new Error(`Cloudinary refused to delete ${publicId}: ${result.result}`);
  }

  return result;
}

/**
 * A short-lived signed URL for an authenticated asset.
 *
 * Minted per request, in the route, *after* the roster check has passed — never
 * baked into a page or stored in the database.  The stored `storagePath` is
 * only an identifier; it is this that grants access, and it expires.
 *
 * @param {string} publicId
 * @param {number} ttlSeconds how long the link stays valid (default 1 hour —
 *        long enough to listen to a meeting straight through, short enough that
 *        a copied link is not a permanent handout)
 */
export function signedAssetUrl(publicId, { resourceType = AUDIO_RESOURCE_TYPE, format = null, ttlSeconds = 3600 } = {}) {
  if (!configured) throw new Error("Cloudinary is not configured");
  if (!publicId) return null;

  return cloudinary.url(publicId, {
    resource_type: resourceType,
    type: "authenticated",
    format: format || undefined,
    secure: true,
    sign_url: true,
    expires_at: Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds),
  });
}

/**
 * Every asset currently in a folder, paged.
 *
 * Used by the janitor cron to find assets with no matching `storagePublicId` —
 * the orphan left behind when an upload succeeds and the database write that
 * was supposed to record it does not.
 */
export async function listFolderAssets(folder = MEETINGS_FOLDER, { resourceType = AUDIO_RESOURCE_TYPE, max = 500 } = {}) {
  if (!configured) throw new Error("Cloudinary is not configured");

  const assets = [];
  let nextCursor = undefined;

  do {
    const page = await cloudinary.api.resources({
      type: "authenticated",
      resource_type: resourceType,
      prefix: folder,
      max_results: 100,
      next_cursor: nextCursor,
    });

    for (const resource of page.resources || []) {
      assets.push({
        publicId: resource.public_id,
        bytes: resource.bytes,
        createdAt: resource.created_at,
        resourceType: resource.resource_type,
      });
    }

    nextCursor = page.next_cursor;
  } while (nextCursor && assets.length < max);

  return assets;
}
