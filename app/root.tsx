import {
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

const navStyle: React.CSSProperties = {
  display: "flex",
  gap: "1rem",
  padding: "1rem 2rem",
  borderBottom: "2px solid #e0e0e0",
  fontFamily: "system-ui, sans-serif",
  backgroundColor: "#f8f9fa",
};

const linkStyle: React.CSSProperties = {
  textDecoration: "none",
  padding: "0.4rem 0.8rem",
  borderRadius: "4px",
  fontSize: "0.9rem",
  fontWeight: 500,
  color: "#495057",
};

const activeLinkStyle: React.CSSProperties = {
  ...linkStyle,
  backgroundColor: "#007bff",
  color: "#fff",
};

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body style={{ margin: 0 }}>
        <nav style={navStyle}>
          <strong style={{ marginRight: "1rem", fontSize: "1rem" }}>
            Inventory Manager
          </strong>
          <NavLink
            to="/app"
            end
            style={({ isActive }) => (isActive ? activeLinkStyle : linkStyle)}
          >
            Sync History
          </NavLink>
          <NavLink
            to="/app/stock"
            style={({ isActive }) => (isActive ? activeLinkStyle : linkStyle)}
          >
            Stock Levels
          </NavLink>
          <NavLink
            to="/app/orders"
            style={({ isActive }) => (isActive ? activeLinkStyle : linkStyle)}
          >
            Orders
          </NavLink>
        </nav>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
