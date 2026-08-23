// App root. Providers, then one switch on session status, then one switch on
// route. Nothing else lives here.
import { ToastProvider } from "@krakatausteel/ui";
import { findRoute } from "./nav";
import { hasPermission } from "./permissions";
import { Dashboard } from "./pages/Dashboard";
import { Forbidden, NotFound, SessionLoading, SessionUnreachable } from "./pages/Fallbacks";
import { Login } from "./pages/Login";
import { Placeholder } from "./pages/Placeholder";
import { ReportCatalog } from "./pages/ReportCatalog";
import { REPORT_GROUPS } from "./reports";
import { RouterProvider, useRouter } from "./router";
import { SessionProvider, useSession } from "./session";
import { AppShell } from "./shell/AppShell";

export function App() {
  return (
    <RouterProvider>
      <SessionProvider>
        <ToastProvider>
          <Root />
        </ToastProvider>
      </SessionProvider>
    </RouterProvider>
  );
}

function Root() {
  const { status } = useSession();

  if (status === "memuat") return <SessionLoading />;
  if (status === "gagal") return <SessionUnreachable />;
  // A real 401 lands here. The shell is never rendered without a session.
  if (status === "keluar") return <Login />;

  return (
    <AppShell>
      <PageOutlet />
    </AppShell>
  );
}

function PageOutlet() {
  const { path } = useRouter();
  const { session } = useSession();
  const route = findRoute(path);

  if (!route) return <NotFound path={path} />;
  if (!hasPermission(session?.permissions ?? [], route.permission)) {
    return <Forbidden title={route.title} />;
  }

  if (path === "/") return <Dashboard />;

  const catalog = REPORT_GROUPS.find((group) => group.path === path);
  if (catalog) return <ReportCatalog group={catalog} />;

  return <Placeholder route={route} />;
}
