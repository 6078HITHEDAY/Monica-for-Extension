import { expect, it } from "vitest";
import { cardFaceImageOptions, cardFaceImageType } from "./card-face-images";
import type { ProviderAttachmentSummary } from "../providers/attachments/attachment-contract";
const image = (attachmentId: string, fileName: string, mediaType?: string): ProviderAttachmentSummary => ({ attachmentId, fileName, mediaType, sizeBytes: 12, protected: true, providerKind: "mdbx2" });
it("uses native filenames and allows old image metadata without a MIME type", () => {
  expect(cardFaceImageOptions([image("a", "card.PNG"), image("b", "artwork", "image/webp"), image("c", "front.jpg", "application/octet-stream")])).toEqual(["card.PNG", "artwork", "front.jpg"]);
});
it("excludes duplicate names and names colliding with a different attachment ID", () => {
  expect(cardFaceImageOptions([image("a", "face.png"), image("b", "face.png"), image("c", "front.png"), image("front.png", "back.png")])).toEqual(["back.png"]);
});
it("excludes active formats and does not override an explicit MIME with an image suffix", () => {
  expect(cardFaceImageOptions([image("a", "image.png", "text/html"), image("b", "art.svg", "image/svg+xml"), image("c", "text.txt", "text/plain")])).toEqual([]);
});
it('recognizes raster content when synchronized attachments have no MIME metadata',()=>{
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64'));
  expect(cardFaceImageType(png)).toBe('image/png');
  expect(cardFaceImageType(new Uint8Array([255,216,255,224]))).toBe('image/jpeg');
  expect(cardFaceImageType(new TextEncoder().encode('GIF89a1234567'))).toBe('image/gif');
  expect(cardFaceImageType(new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe('image/webp');
});
it('never treats active content or truncated headers as card images',()=>{
  for(const input of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>','<html><script>alert(1)</script></html>','GIF89a','RIFF0000WEBPxxxx'])
    expect(cardFaceImageType(new TextEncoder().encode(input))).toBeUndefined();
  expect(cardFaceImageType(new Uint8Array([137,80,78,71,13,10,26,10]))).toBeUndefined();
});
