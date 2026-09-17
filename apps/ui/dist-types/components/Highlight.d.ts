export interface HighlightProps {
    text: string;
    /** The raw search query. Empty renders the text unchanged. */
    query: string;
}
/**
 * Mark the parts of `text` that caused this result to match.
 *
 * Splits the query with the same parser the database uses, so the highlighting
 * always agrees with the matching. Previously it matched the whole query as one
 * string: once search became term-based, "flexibility program" returned a
 * result with nothing highlighted at all — the user could see a hit but not why
 * it was one. Showing the match is part of the search working, not decoration.
 *
 * Terms are escaped before reaching RegExp, so a designer searching `C++` or
 * `(MSN)` cannot produce an invalid pattern.
 */
export declare function Highlight({ text, query }: HighlightProps): JSX.Element;
//# sourceMappingURL=Highlight.d.ts.map