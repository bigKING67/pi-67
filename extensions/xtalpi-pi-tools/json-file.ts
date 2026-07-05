import { readFileSync } from "node:fs";

function countUtf16NulPattern(buffer: Buffer): { pairLimit: number; oddNuls: number; evenNuls: number } {
  const pairLimit = Math.min(Math.floor(buffer.length / 2), 128);
  let oddNuls = 0;
  let evenNuls = 0;
  for (let pair = 0; pair < pairLimit; pair += 1) {
    if (buffer[pair * 2] === 0) evenNuls += 1;
    if (buffer[pair * 2 + 1] === 0) oddNuls += 1;
  }
  return { pairLimit, oddNuls, evenNuls };
}

function looksUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const { pairLimit, oddNuls, evenNuls } = countUtf16NulPattern(buffer);
  return pairLimit >= 2 && oddNuls >= Math.ceil(pairLimit * 0.3) && oddNuls > evenNuls * 2;
}

function looksUtf16Be(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const { pairLimit, oddNuls, evenNuls } = countUtf16NulPattern(buffer);
  return pairLimit >= 2 && evenNuls >= Math.ceil(pairLimit * 0.3) && evenNuls > oddNuls * 2;
}

function decodeUtf16Be(buffer: Buffer): string {
  const usableLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(usableLength);
  for (let index = 0; index < usableLength; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped.toString("utf16le");
}

export function decodeJsonText(buffer: Buffer): string {
  let text: string;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    text = buffer.subarray(3).toString("utf8");
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.subarray(2).toString("utf16le");
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    text = decodeUtf16Be(buffer.subarray(2));
  } else if (looksUtf16Le(buffer)) {
    text = buffer.toString("utf16le");
  } else if (looksUtf16Be(buffer)) {
    text = decodeUtf16Be(buffer);
  } else {
    text = buffer.toString("utf8");
  }
  return text.replace(/^[\uFEFF\u0000]+/, "");
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(decodeJsonText(readFileSync(file)));
}
