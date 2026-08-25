// App root. Providers, then one switch on session status, then one switch on
// route. Nothing else lives here.
import { ToastProvider } from "@krakatausteel/ui";
import { matchRoute, type PageRoute } from "./nav";
import { hasPermission } from "./permissions";
import { Dashboard } from "./pages/Dashboard";
import { Forbidden, NotFound, SessionLoading, SessionUnreachable } from "./pages/Fallbacks";
import { Login } from "./pages/Login";
import { Placeholder } from "./pages/Placeholder";
import { Parameter } from "./pages/konfigurasi/Parameter";
import { ReportCatalog } from "./pages/ReportCatalog";
import { Lpj } from "./pages/nonpumk/Lpj";
import { MonitoringLpj } from "./pages/nonpumk/MonitoringLpj";
import { Penilaian } from "./pages/nonpumk/Penilaian";
import { Penyaluran } from "./pages/nonpumk/Penyaluran";
import { Persetujuan as PersetujuanNonPumk } from "./pages/nonpumk/Persetujuan";
import { ProposalDetail as ProposalDetailNonPumk } from "./pages/nonpumk/ProposalDetail";
import { ProposalForm as ProposalFormNonPumk } from "./pages/nonpumk/ProposalForm";
import { ProposalList as ProposalListNonPumk } from "./pages/nonpumk/ProposalList";
import { ReviewChecker as ReviewCheckerNonPumk } from "./pages/nonpumk/ReviewChecker";
import { AkadForm } from "./pages/pumk/AkadForm";
import { AngsuranForm } from "./pages/pumk/AngsuranForm";
import { ClusterDetail, ClusterList } from "./pages/pumk/Cluster";
import { JadwalPage } from "./pages/pumk/JadwalPage";
import { JaminanForm } from "./pages/pumk/JaminanForm";
import { KartuPiutangPage, KartuPiutangPicker } from "./pages/pumk/KartuPiutang";
import { MitraBermasalah } from "./pages/pumk/MitraBermasalah";
import { PencairanForm } from "./pages/pumk/PencairanForm";
import { Pengakhiran } from "./pages/pumk/Pengakhiran";
import { Persetujuan } from "./pages/pumk/Persetujuan";
import { ProposalDetail } from "./pages/pumk/ProposalDetail";
import { ProposalForm } from "./pages/pumk/ProposalForm";
import { ProposalList } from "./pages/pumk/ProposalList";
import { ReviewChecker } from "./pages/pumk/ReviewChecker";
import { Reschedule } from "./pages/pumk/Reschedule";
import { Simulasi } from "./pages/pumk/Simulasi";
import { SurveyForm } from "./pages/pumk/SurveyForm";
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

/**
 * The pages that exist, keyed by the route path in ./nav.ts. A path missing
 * from this table falls through to the Placeholder, which is what keeps the
 * "not built yet" pages honest instead of rendering a blank area.
 *
 * The renderer receives the route (for its title and summary) and the path
 * parameters the matcher extracted, so a detail page never has to parse the
 * URL itself.
 */
const HALAMAN: Record<
  string,
  (route: PageRoute, params: Record<string, string>) => JSX.Element
> = {
  "/pumk/proposal": (route) => <ProposalList route={route} />,
  "/pumk/proposal/baru": (route) => <ProposalForm route={route} />,
  "/pumk/proposal/:proposalId": (route, params) => (
    <ProposalDetail route={route} proposalId={params.proposalId ?? ""} />
  ),
  "/pumk/survey": (route) => <SurveyForm route={route} />,
  "/pumk/jaminan": (route) => <JaminanForm route={route} />,
  "/pumk/review": (route) => <ReviewChecker route={route} />,
  "/pumk/persetujuan": (route) => <Persetujuan route={route} />,
  "/pumk/akad": (route) => <AkadForm route={route} />,
  "/pumk/jadwal": (route) => <JadwalPage route={route} />,
  "/pumk/pencairan": (route) => <PencairanForm route={route} />,
  "/pumk/angsuran": (route) => <AngsuranForm route={route} />,
  "/pumk/simulasi": (route) => <Simulasi route={route} />,
  "/pumk/kartu-piutang": (route) => <KartuPiutangPicker route={route} />,
  "/pumk/kartu-piutang/:akadId": (route, params) => (
    <KartuPiutangPage route={route} akadId={params.akadId ?? ""} />
  ),
  "/pumk/cluster": (route) => <ClusterList route={route} />,
  "/pumk/cluster/:clusterId": (route, params) => (
    <ClusterDetail route={route} clusterId={params.clusterId ?? ""} />
  ),
  "/pumk/reschedule": (route) => <Reschedule route={route} />,
  "/pumk/pengakhiran": (route) => <Pengakhiran route={route} />,
  "/pumk/mitra-bermasalah": (route) => <MitraBermasalah route={route} />,

  "/nonpumk/proposal": (route) => <ProposalListNonPumk route={route} />,
  "/nonpumk/proposal/baru": (route) => <ProposalFormNonPumk route={route} />,
  "/nonpumk/proposal/:proposalId": (route, params) => (
    <ProposalDetailNonPumk route={route} proposalId={params.proposalId ?? ""} />
  ),
  "/nonpumk/penilaian": (route) => <Penilaian route={route} />,
  "/nonpumk/review": (route) => <ReviewCheckerNonPumk route={route} />,
  "/nonpumk/persetujuan": (route) => <PersetujuanNonPumk route={route} />,
  "/nonpumk/penyaluran": (route) => <Penyaluran route={route} />,
  "/nonpumk/lpj": (route) => <Lpj route={route} />,
  "/nonpumk/monitoring-lpj": (route) => <MonitoringLpj route={route} />,

  "/konfigurasi/parameter": (route) => <Parameter route={route} />,
};

function PageOutlet() {
  const { path } = useRouter();
  const { session } = useSession();
  const hit = matchRoute(path);

  if (!hit) return <NotFound path={path} />;
  const { route, params } = hit;
  if (!hasPermission(session?.permissions ?? [], route.permission)) {
    return <Forbidden title={route.title} />;
  }

  if (route.path === "/") return <Dashboard />;

  const halaman = HALAMAN[route.path];
  if (halaman) return halaman(route, params);

  const catalog = REPORT_GROUPS.find((group) => group.path === route.path);
  if (catalog) return <ReportCatalog group={catalog} />;

  return <Placeholder route={route} />;
}
