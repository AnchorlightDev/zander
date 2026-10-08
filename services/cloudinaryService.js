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
