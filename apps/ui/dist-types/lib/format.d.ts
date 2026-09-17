/** Shared formatting helpers. */
export declare function formatBytes(bytes: number): string;
export declare function formatDate(iso: string | null): string;
export declare function formatDateTime(iso: string | null): string;
/** `HH:MM:SS` or `MM:SS` to seconds — used to seek the video preview. */
export declare function timestampToSeconds(value: string): number;
/** Drop a leading `00:` so chapter lists read as `2:14` rather than `00:02:14`. */
export declare function shortTimestamp(value: string): string;
//# sourceMappingURL=format.d.ts.map