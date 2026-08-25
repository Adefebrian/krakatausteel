// Detail Proposal Non PUMK, spec 9.2. One program, everything recorded about
// it, and the ledger's own answer next to the business rows.
//
// THE PAGE PROVES THE TWO AGREE INSTEAD OF ASSERTING IT. `bebanBersihBukuBesar`
// and `kasBersihBukuBesar` are read from the POSTED journals of this program,
// not recomputed from the termin rows, so they are printed next to the
// disbursed total and the LPJ realisation and a reader can see for themselves
// whether they tie. After a grant disbursed in full with a realisation smaller
// than that and the difference returned, the expense must be exactly the
// realisation and the cash movement exactly its negative. A page that only
// showed the business rows would let a broken posting sit there unnoticed.
//
// The timeline records WHO by user id, because that is what the transition
// endpoint carries. It is labelled as an id rather than dressed up as a name.
import {
  Bento,
  BentoItem,
  Button,
  DataList,
  DataTable,
  ErrorState,
  Icon,
  Panel,
  Stat,
  StatusBadge,
  Timeline,
  bandingUang,
  formatCount,
  formatDate,
  formatMoney,
  formatTotal,
  kurangkanUang,
  type Column,
} from "@krakatausteel/ui";
import {
  detailProposal,
  timelineProposal,
  type DetailProposalNonPumk,
  type Penyaluran as TerminPenyaluran,
} from "../../api/nonpumk";
import { useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import { CatatanOtorisasi, HalamanModul, Muat } from "../shared/parts";
import { Pagu, RingkasProgram, SdgDaftar } from "./parts";

const KOLOM_TERMIN: readonly Column<TerminPenyaluran>[] = [
  { key: "termin", header: "Termin", type: "count", width: "90px" },
  { key: "tanggalPenyaluran", header: "Tanggal", type: "date", width: "130px" },
  { key: "jumlah", header: "Jumlah", type: "money", width: "160px" },
  { key: "noBukti", header: "No bukti", width: "150px", render: (row) => row.noBukti ?? "Tidak diisi" },
  {
    key: "keterangan",
    header: "Keterangan",
    render: (row) => <span className="sel-ringkas">{row.keterangan ?? "Tidak diisi"}</span>,
  },
];

const AKSI_LABEL: Record<string, string> = {
  AJUKAN_PENILAIAN: "Diajukan ke penilaian",
  INPUT_PENILAIAN: "Penilaian disimpan",
  REKOMENDASI: "Direkomendasikan Checker",
  TIDAK_REKOMENDASI: "Tidak direkomendasikan",
  MINTA_PERBAIKAN: "Dikembalikan untuk perbaikan",
  SETUJU: "Disetujui Approver",
  TOLAK: "Ditolak Approver",
  KEMBALIKAN: "Dikembalikan ke Checker",
  PENYALURAN: "Termin penyaluran dicatat",
  TUTUP_PENYALURAN: "Penyaluran ditutup",
  AJUKAN_LPJ: "LPJ diajukan",
  VERIFIKASI_LPJ: "LPJ diterima",
  TOLAK_LPJ: "LPJ ditolak",
};

/** The next step a user with the right permission can take from here. */
function langkahBerikut(
  status: string,
  permissions: readonly string[],
): { label: string; to: string } | null {
  const bisa = (izin: string) => hasPermission(permissions, izin as never);
  switch (status) {
    case "PENILAIAN":
      return bisa("nonpumk.penilaian") ? { label: "Buka penilaian", to: "/nonpumk/penilaian" } : null;
    case "REVIEW_CHECKER":
      return bisa("nonpumk.review") ? { label: "Buka review Checker", to: "/nonpumk/review" } : null;
    case "MENUNGGU_PERSETUJUAN":
      return bisa("nonpumk.approve") ? { label: "Buka persetujuan", to: "/nonpumk/persetujuan" } : null;
    case "DISETUJUI":
    case "DISALURKAN":
      return bisa("nonpumk.penyaluran") ? { label: "Buka penyaluran", to: "/nonpumk/penyaluran" } : null;
    case "MENUNGGU_LPJ":
    case "LPJ_DIAJUKAN":
    case "LPJ_DITOLAK":
      return bisa("nonpumk.lpj") ? { label: "Buka LPJ", to: "/nonpumk/lpj" } : null;
    default:
      return null;
  }
}

export function ProposalDetail({ route, proposalId }: { route: PageRoute; proposalId: string }) {
  const session = useActiveSession();
  const { navigate } = useRouter();

  const detail = useApi(() => detailProposal(proposalId), [proposalId]);
  const timeline = useApi(() => timelineProposal(proposalId), [proposalId]);

  return (
    <HalamanModul route={route} back={{ to: "/nonpumk/proposal", label: "Daftar proposal" }}>
      <Muat hasil={detail} judul="detail program" sumber={`GET /api/nonpumk/proposal/${proposalId}`}>
        {(data: DetailProposalNonPumk) => {
          const { proposal, penilaian, lpj } = data;
          const lanjut = langkahBerikut(proposal.status, session.permissions);
          const sisaLpj = lpj?.jumlahSisaDikembalikan ?? null;

          // The ledger's own figures against the business rows. Printed, not
          // asserted: the difference is what a reader needs to see.
          const selisihBeban =
            lpj === null
              ? kurangkanUang(data.bebanBersihBukuBesar, data.totalDisalurkan)
              : kurangkanUang(data.bebanBersihBukuBesar, lpj.jumlahRealisasi);
          const bebanCocok = selisihBeban === null ? null : bandingUang(selisihBeban, "0.00") === 0;

          return (
            <>
              <RingkasProgram
                proposal={proposal}
                bidangNama={data.bidangNama}
                cabangNama={data.cabangNama}
                sdg={data.sdg}
              />

              <Bento columns={4}>
                <BentoItem span="sm">
                  <Panel as="h2" title="Status program" className="panel-kpi">
                    <Stat
                      label="Tahap saat ini"
                      value={<StatusBadge status={proposal.status} />}
                      hint={`Langkah ${formatCount(proposal.currentStep)} pada alur spesifikasi 9.2.`}
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Nilai diajukan" className="panel-kpi">
                    <Stat
                      label="Permintaan pemohon"
                      value={formatMoney(proposal.jumlahDiajukan)}
                      hint={`Tanggal proposal ${formatDate(proposal.tanggalProposal)}.`}
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Penerima manfaat" className="panel-kpi">
                    <Stat
                      label={lpj ? "Aktual pada LPJ" : "Estimasi pada proposal"}
                      value={
                        lpj?.penerimaManfaatAktual != null
                          ? formatCount(lpj.penerimaManfaatAktual)
                          : proposal.penerimaManfaatEstimasi === null
                            ? "Belum diisi"
                            : formatCount(proposal.penerimaManfaatEstimasi)
                      }
                      hint={
                        lpj?.penerimaManfaatAktual != null && proposal.penerimaManfaatEstimasi !== null
                          ? `Estimasi awal ${formatCount(proposal.penerimaManfaatEstimasi)} orang.`
                          : "Angka aktual diisi pada LPJ."
                      }
                    />
                  </Panel>
                </BentoItem>
                <BentoItem span="sm">
                  <Panel as="h2" title="Status LPJ" className="panel-kpi">
                    <Stat
                      label="Pertanggungjawaban"
                      value={
                        lpj === null ? (
                          "Belum ada"
                        ) : (
                          <StatusBadge
                            status={`LPJ_${lpj.status}`}
                            label={
                              lpj.status === "DIVERIFIKASI"
                                ? "Diverifikasi"
                                : lpj.status === "DIAJUKAN"
                                  ? "Diajukan"
                                  : lpj.status === "DITOLAK"
                                    ? "Ditolak"
                                    : "Belum masuk"
                            }
                          />
                        )
                      }
                      hint={
                        lpj === null
                          ? "LPJ diisi setelah penyaluran ditutup."
                          : `Tanggal LPJ ${formatDate(lpj.tanggalLpj)}.`
                      }
                    />
                  </Panel>
                </BentoItem>
              </Bento>

              <Pagu
                disetujui={proposal.jumlahDisetujui}
                disalurkan={data.totalDisalurkan}
                sisa={proposal.jumlahDisetujui === null ? null : data.sisaPagu}
                catatanSisa="Nilai disetujui dikurangi seluruh termin, dihitung engine dalam satuan sen."
              />

              <div className="banding">
                <Panel
                  as="h2"
                  title="Data program"
                  aside={<StatusBadge status={proposal.status} />}
                  footer={<span>Sumber pengajuan: {proposal.sumberPengajuan === "PORTAL_ONLINE" ? "Portal Online" : "Internal cabang"}.</span>}
                >
                  <DataList
                    items={[
                      { label: "No proposal", value: proposal.noProposal },
                      { label: "Pemohon", value: proposal.namaPemohon },
                      { label: "Atas nama", value: proposal.atasNama ?? "Sama dengan pemohon" },
                      { label: "Bidang", value: `${data.bidangKode} ${data.bidangNama}` },
                      { label: "Judul program", value: proposal.judulProgram, wide: true },
                      {
                        label: "Deskripsi",
                        value: proposal.deskripsiProgram ?? "Tidak ada deskripsi",
                        wide: true,
                      },
                    ]}
                  />
                </Panel>

                <Panel
                  as="h2"
                  title="Pemetaan SDG"
                  description="Bobot menunjukkan seberapa besar program ini menyumbang pada tiap tujuan. Bobot tidak harus berjumlah satu."
                  footer={<span>Dipakai laporan rekap program per SDG.</span>}
                >
                  <SdgDaftar sdg={data.sdg} />
                </Panel>
              </div>

              <div className="banding">
                <Panel
                  as="h2"
                  title="Hasil penilaian"
                  aside={
                    penilaian ? (
                      <StatusBadge status="DISETUJUI" label="Sudah dinilai" tone="info" />
                    ) : (
                      <StatusBadge status="PENILAIAN" label="Belum dinilai" tone="neutral" />
                    )
                  }
                  footer={
                    <span>
                      {penilaian
                        ? "Satu program memiliki satu baris penilaian, penilaian ulang memperbaruinya."
                        : "Penilaian diisi sebelum program masuk review Checker."}
                    </span>
                  }
                >
                  {penilaian ? (
                    <DataList
                      items={[
                        { label: "Tanggal penilaian", value: formatDate(penilaian.tanggal) },
                        {
                          label: "Skor total",
                          value: formatMoney(penilaian.skorTotal ?? "0.00"),
                          numeric: true,
                        },
                        {
                          label: "Nilai rekomendasi",
                          value: formatMoney(penilaian.nilaiRekomendasi ?? "0.00"),
                          numeric: true,
                        },
                        {
                          label: "Catatan penilai",
                          value: penilaian.catatan ?? "Tidak ada catatan",
                          wide: true,
                        },
                      ]}
                    />
                  ) : (
                    <p className="penjelasan">Belum ada penilaian kelayakan untuk program ini.</p>
                  )}
                </Panel>

                <Panel
                  as="h2"
                  title="Laporan Pertanggungjawaban"
                  aside={lpj ? <StatusBadge status={`LPJ_${lpj.status}`} label={lpj.status === "DIVERIFIKASI" ? "Diverifikasi" : lpj.status === "DIAJUKAN" ? "Diajukan" : lpj.status === "DITOLAK" ? "Ditolak" : "Belum masuk"} /> : undefined}
                  footer={
                    <span>
                      {lpj === null
                        ? "LPJ wajib untuk setiap program Non PUMK, tanpa kecuali."
                        : sisaLpj !== null && bandingUang(sisaLpj, "0.00") === 1
                          ? "Sisa di atas nol membentuk jurnal pengembalian saat LPJ diterima."
                          : "Realisasi sama dengan dana yang disalurkan, sehingga tidak ada jurnal pengembalian."}
                    </span>
                  }
                >
                  {lpj ? (
                    <DataList
                      items={[
                        { label: "Tanggal LPJ", value: formatDate(lpj.tanggalLpj) },
                        {
                          label: "Dana disalurkan",
                          value: formatMoney(data.totalDisalurkan),
                          numeric: true,
                        },
                        {
                          label: "Realisasi",
                          value: formatMoney(lpj.jumlahRealisasi),
                          numeric: true,
                        },
                        {
                          label: "Sisa dikembalikan",
                          value: formatMoney(lpj.jumlahSisaDikembalikan),
                          numeric: true,
                        },
                        {
                          label: "Jurnal pengembalian",
                          value: lpj.jurnalIdPengembalian ?? "Belum terbentuk",
                        },
                        {
                          label: "Uraian realisasi",
                          value: lpj.uraianRealisasi ?? "Tidak ada uraian",
                          wide: true,
                        },
                      ]}
                    />
                  ) : (
                    <p className="penjelasan">
                      Belum ada LPJ. Jam keterlambatan mulai berjalan setelah penyaluran ditutup,
                      dihitung dari tanggal termin terakhir.
                    </p>
                  )}
                </Panel>
              </div>

              <Panel
                as="h2"
                title="Termin penyaluran"
                description="Setiap termin memiliki jurnal penyalurannya sendiri."
                footer={
                  <span>
                    Total {formatTotal(data.penyaluran.map((row) => row.jumlah))} dari{" "}
                    {formatCount(data.penyaluran.length)} termin, dijumlahkan dalam satuan sen.
                  </span>
                }
              >
                <div className="daftar-tabel">
                  <DataTable
                    columns={KOLOM_TERMIN}
                    rows={data.penyaluran}
                    rowKey={(row) => row.id}
                    caption="Termin penyaluran program ini"
                    emptyTitle="Belum ada termin yang tercatat"
                    emptyDescription="Termin pertama tercatat setelah program disetujui dan penyalurannya dilakukan."
                  />
                </div>
                <div className="daftar-kartu">
                  {data.penyaluran.length === 0 ? (
                    <p className="penjelasan">Belum ada termin yang tercatat pada program ini.</p>
                  ) : (
                    <ul className="kartu-list">
                      {data.penyaluran.map((row) => (
                        <li className="kartu-item" key={row.id}>
                          <span className="kartu-btn is-statis">
                            <span className="kartu-head">
                              <span className="kartu-judul">Termin {formatCount(row.termin)}</span>
                            </span>
                            <span className="kartu-sub">
                              {formatDate(row.tanggalPenyaluran)} .{" "}
                              {row.noBukti ?? "Tanpa nomor bukti"}
                            </span>
                            <span className="kartu-foot">
                              <span className="kartu-meta">{row.keterangan ?? ""}</span>
                              <span className="kartu-nilai">
                                <span className="kartu-nilai-label">Jumlah</span>
                                <span className="kartu-nilai-val">{formatMoney(row.jumlah)}</span>
                              </span>
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Panel>

              <Panel
                as="h2"
                title="Kecocokan dengan Buku Besar"
                description="Angka di bawah dibaca dari jurnal yang sudah diposting untuk program ini, bukan dihitung ulang dari baris terminnya."
                aside={
                  bebanCocok === null ? undefined : (
                    <StatusBadge
                      status={bebanCocok ? "COCOK" : "SELISIH"}
                      tone={bebanCocok ? "success" : "warning"}
                      label={bebanCocok ? "Cocok" : "Ada selisih"}
                    />
                  )
                }
                footer={
                  <span>
                    {lpj === null
                      ? "Sebelum LPJ, beban bersih seharusnya sama dengan total yang disalurkan."
                      : "Setelah LPJ diterima dan sisanya dikembalikan, beban bersih seharusnya sama dengan realisasi."}
                  </span>
                }
              >
                <DataList
                  columns={2}
                  items={[
                    {
                      label: "Beban bersih Buku Besar",
                      value: formatMoney(data.bebanBersihBukuBesar),
                      numeric: true,
                    },
                    {
                      label: "Kas bersih Buku Besar",
                      value: formatMoney(data.kasBersihBukuBesar),
                      numeric: true,
                    },
                    {
                      label: lpj === null ? "Total disalurkan" : "Realisasi LPJ",
                      value: formatMoney(lpj === null ? data.totalDisalurkan : lpj.jumlahRealisasi),
                      numeric: true,
                    },
                    {
                      label: "Selisih",
                      value: selisihBeban === null ? "Tidak dapat dihitung" : formatMoney(selisihBeban),
                      numeric: true,
                    },
                  ]}
                />
              </Panel>

              <Panel
                as="h2"
                title="Timeline persetujuan"
                description="Siapa memindahkan dokumen ke status apa, kapan, dengan catatan apa."
                footer={
                  <span>
                    Endpoint timeline mengirim ID pengguna, bukan nama. Yang ditampilkan adalah
                    ID itu apa adanya, bukan nama yang dikira kira dari data lain.
                  </span>
                }
              >
                <Muat
                  hasil={timeline}
                  judul="timeline program"
                  sumber={`GET /api/nonpumk/proposal/${proposalId}/timeline`}
                >
                  {(riwayat) =>
                    // A body that arrived without its `data` array is a broken
                    // answer, not an empty one. Rendering it as "no transitions
                    // recorded" would be a silent zero: the reader would
                    // conclude nobody ever moved this document. Say the answer
                    // could not be read instead.
                    !Array.isArray(riwayat.data) ? (
                      <ErrorState
                        title="Timeline tidak dapat dibaca"
                        description="Server menjawab, tetapi jawabannya tidak memuat daftar transisi. Ini bukan pernyataan bahwa program ini belum pernah berpindah status."
                        sumber={`GET /api/nonpumk/proposal/${proposalId}/timeline`}
                        onRetry={timeline.reload}
                      />
                    ) : (
                    <Timeline
                      entries={riwayat.data.map((baris, index) => ({
                        id: `${baris.waktu}-${index}`,
                        status: baris.statusKe,
                        action: AKSI_LABEL[baris.aksi] ?? baris.aksi,
                        actor:
                          baris.olehUserId === null
                            ? "Tidak tercatat"
                            : `ID pengguna ${baris.olehUserId.slice(0, 8)}`,
                        at: formatDate(baris.waktu),
                        note: baris.catatan ?? undefined,
                      }))}
                      emptyLabel="Belum ada transisi yang tercatat untuk program ini."
                    />
                    )
                  }
                </Muat>
              </Panel>

              {lanjut ? (
                <Panel
                  as="h2"
                  title="Langkah berikutnya"
                  description="Tersedia karena hak akses Anda mencakup tahap ini. Server tetap memvalidasi ulang setiap permintaan."
                  footer={<span>Halaman tujuan membuka program ini secara langsung.</span>}
                >
                  <Button
                    variant="primary"
                    leading={<Icon name="arrowRight" size={16} />}
                    onClick={() => navigate(`${lanjut.to}?proposal=${proposal.id}`)}
                  >
                    {lanjut.label}
                  </Button>
                </Panel>
              ) : null}
            </>
          );
        }}
      </Muat>
      <CatatanOtorisasi />
    </HalamanModul>
  );
}
