export interface ImageAttachment {
  name: string;
  dataUrl: string;
}

export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export function isImageDataUrl(value: string): boolean {
  if (value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 32) return false;
  const match =
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value,
    );
  if (!match || match[2]!.length % 4 !== 0) return false;
  const data = match[2]!;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding <= MAX_IMAGE_BYTES;
}

export function parseImages(value: unknown): ImageAttachment[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_IMAGES ||
    !value.every(
      (image: unknown): image is ImageAttachment =>
        image !== null &&
        typeof image === "object" &&
        "name" in image &&
        typeof image.name === "string" &&
        image.name.length > 0 &&
        image.name.length <= 255 &&
        "dataUrl" in image &&
        typeof image.dataUrl === "string" &&
        isImageDataUrl(image.dataUrl),
    )
  ) {
    throw new Error(
      "Attach up to five PNG, JPEG, GIF or WebP images, at most 5 MiB each.",
    );
  }
  return value.map(({ name, dataUrl }) => ({ name, dataUrl }));
}

export function isImageSource(value: string): boolean {
  if (isImageDataUrl(value)) return true;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}
