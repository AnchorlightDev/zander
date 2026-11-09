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
      // allowed_formats makes Cloudinary reject anything that is not one of
      // these after its own sniffing, so a disguised SVG cannot be stored.
      { folder, resource_type: resourceType, allowed_formats: ["png", "jpg", "jpeg", "gif", "webp"] },
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

/**
 * Upload an audio file (e.g. the Wrapped music bed). Cloudinary treats audio as
 * a "video" resource, so delivery/transforms go through that pipeline. Returns
 * the secure URL and basic metadata.
 */
export async function uploadAudio(buffer, { folder = "zander/wrapped" } = {}) {
  if (!configured) throw new Error("Cloudinary is not configured");

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "video",
        allowed_formats: ["mp3", "ogg", "wav", "m4a", "aac", "webm"],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          bytes: result.bytes,
          duration: result.duration,
        });
      }
    );
    stream.end(buffer);
  });
}
