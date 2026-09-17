/** Chrome for the internal tool. Public intake pages use `PublicLayout` instead. */
export declare function Layout(): JSX.Element;
/**
 * Layout for the public intake pages. No internal navigation: an external
 * vendor should not see links into the audit tool.
 */
export declare function PublicLayout(): JSX.Element;
export interface PageHeaderProps {
    title: string;
    description?: string;
    children?: React.ReactNode;
}
export declare function PageHeader({ title, description, children }: PageHeaderProps): JSX.Element;
//# sourceMappingURL=Layout.d.ts.map