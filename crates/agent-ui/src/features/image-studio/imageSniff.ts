// Browsers derive File.type from the extension, never the bytes, so a JPEG saved
// as ".png" arrives labelled image/png and K-brain rejects the mismatch. Reading
// the magic bytes lets the upload carry the real type.

export type UploadMime = "image/png" | "image/jpeg" | "image/webp";
export type SniffResult =
  | { kind: "supported"; mime: UploadMime; label: string }
  | { kind: "unsupported"; label: string }
  | { kind: "unknown" };

export const UPLOAD_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));
const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, index) => bytes[index] === value);

export function sniffImageBytes(bytes: Uint8Array): SniffResult {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: "supported", mime: "image/png", label: "PNG" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff]))
    return { kind: "supported", mime: "image/jpeg", label: "JPEG" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return { kind: "supported", mime: "image/webp", label: "WebP" };
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return { kind: "unsupported", label: "GIF" };
  if (head.startsWith("BM")) return { kind: "unsupported", label: "BMP" };
  if (head.startsWith("II*\u0000") || head.startsWith("MM\u0000*"))
    return { kind: "unsupported", label: "TIFF" };
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return { kind: "unsupported", label: "AVIF" };
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand))
      return { kind: "unsupported", label: "HEIC" };
  }
  if (/^\s*<(\?xml|svg)/i.test(ascii(bytes, 0, bytes.length)))
    return { kind: "unsupported", label: "SVG" };
  return { kind: "unknown" };
}

export async function sniffImage(blob: Blob): Promise<SniffResult> {
  try {
    return sniffImageBytes(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
  } catch {
    return { kind: "unknown" };
  }
}
