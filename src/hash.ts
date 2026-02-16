/**
 * FNV-1a 32-bit hash mapped to two lowercase letters (a-z).
 *
 * The hash covers the full line content (including whitespace) but
 * excludes the line terminator (\n, \r\n).
 */

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export function fnv1a32(data: string): number {
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < data.length; i++) {
        // Process UTF-16 code units. For ASCII-dominated source code
        // this is equivalent to byte-level FNV-1a. For multi-byte
        // characters we hash both bytes of the code unit, which is
        // fine — we only need distribution, not cryptographic strength.
        const code = data.charCodeAt(i);
        if (code < 0x80) {
            hash ^= code;
            hash = Math.imul(hash, FNV_PRIME) >>> 0;
        } else {
            hash ^= code & 0xff;
            hash = Math.imul(hash, FNV_PRIME) >>> 0;
            hash ^= (code >> 8) & 0xff;
            hash = Math.imul(hash, FNV_PRIME) >>> 0;
        }
    }
    return hash >>> 0;
}


export function lineHash(line: string): string {
    const h = fnv1a32(line);
    const letter1 = String.fromCharCode(97 + (h % 26));
    const letter2 = String.fromCharCode(97 + ((h >>> 8) % 26));
    return letter1 + letter2;
}

/**
 * Format a single line with its line number and hash.
 * lineNumber is 1-based.
 */
export function formatLine(lineNumber: number, content: string): string {
    return `${lineNumber}:${lineHash(content)}|${content}`;
}
