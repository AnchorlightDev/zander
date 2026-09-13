import { isCloudinaryConfigured, uploadImage } from "../../services/cloudinaryService.js";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export default function uploadApiRoute(app, config, db, features, lang) {

  app.post("/api/upload/image", async (req, res) => {
    if (!req.session?.user) {
      return res.status(401).send({ success: false, message: "Authentication required." });
    }

    if (!isCloudinaryConfigured()) {
      return res.status(503).send({ success: false, message: "Image uploads are not configured." });
    }

    let data;
    try {
      data = await req.file();
    } catch {
      return res.status(400).send({ success: false, message: "No file provided." });
    }

    if (!data || !data.file) {
      return res.status(400).send({ success: false, message: "No file provided." });
    }

    if (!ALLOWED_MIME.includes(data.mimetype)) {
      return res.status(400).send({
        success: false,
        message: "Invalid file type. Allowed: PNG, JPG, GIF, WebP.",
      });
    }

    const folder = data.fields?.folder?.value || "zander";

    try {
      const chunks = [];
      let totalSize = 0;
      for await (const chunk of data.file) {
        totalSize += chunk.length;
        if (totalSize > MAX_FILE_SIZE) {
          return res.status(413).send({ success: false, message: "File too large. Maximum 8 MB." });
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const result = await uploadImage(buffer, { folder });

      return res.send({
        success: true,
        data: {
          url: result.url,
          publicId: result.publicId,
          width: result.width,
          height: result.height,
        },
      });
    } catch (error) {
      console.error("[upload] Cloudinary upload failed:", error);
      return res.status(500).send({ success: false, message: "Upload failed. Please try again." });
    }
  });
}
