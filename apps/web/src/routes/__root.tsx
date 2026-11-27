import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Occavoy · Make room for the experience" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: Layout,
  shellComponent: Document,
});

function Layout() {
  return (
    <>
      <header className="site-header">
        <Link to="/" className="wordmark">
          occavoy<span>↗</span>
        </Link>
        <nav aria-label="Main navigation">
          <Link to="/" activeOptions={{ exact: true }}>
            Discover
          </Link>
          <Link to="/case">My experience</Link>
          <Link to="/partners">Partner desk</Link>
        </nav>
        <span className="market">Hong Kong · Global destinations</span>
      </header>
      <main>
        <Outlet />
      </main>
      <footer>
        Development preview · Illustrative experiences and prices · No booking or payment is
        submitted.
      </footer>
    </>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en-HK">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
