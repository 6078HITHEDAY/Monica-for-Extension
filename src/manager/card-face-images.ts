import type { ProviderAttachmentSummary } from "../providers/attachments/attachment-contract";

/** Android/archives may omit MIME metadata. Only recognize passive raster
 * formats by their bytes; never turn arbitrary filenames/HTML/SVG into images. */
export function cardFaceImageType(bytes: Uint8Array): string | undefined {
  const prefix = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (bytes.length >= 24 && prefix(137,80,78,71,13,10,26,10) && bytes[12]===73 && bytes[13]===72 && bytes[14]===68 && bytes[15]===82) return 'image/png';
  if (bytes.length >= 4 && prefix(255,216,255)) return 'image/jpeg';
  if (bytes.length >= 13 && (prefix(71,73,70,56,55,97) || prefix(71,73,70,56,57,97))) return 'image/gif';
  if (bytes.length >= 16 && prefix(82,73,70,70) && bytes[8]===87 && bytes[9]===69 && bytes[10]===66 && bytes[11]===80 && bytes[12]===86 && bytes[13]===80 && bytes[14]===56 && [32,76,88].includes(bytes[15])) return 'image/webp';
}

/** Persist filenames, as Android does; ambiguous names must not select arbitrary bytes. */
export function cardFaceImageOptions(attachments: readonly ProviderAttachmentSummary[]): string[] {
  return attachments.filter(item => {
    const mime = item.mediaType?.split(";")[0].trim().toLowerCase();
    const image = mime && mime !== "application/octet-stream"
      ? /^image\/(png|jpeg|webp|gif)$/.test(mime)
      : /\.(png|jpe?g|webp|gif)$/i.test(item.fileName);
    return image && attachments.filter(other => other.fileName === item.fileName || other.attachmentId === item.fileName).length === 1;
  }).map(item => item.fileName);
}
