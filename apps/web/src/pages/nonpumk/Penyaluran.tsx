// Penyaluran Non PUMK, spec 9.2. Staged disbursement: several termin against
// ONE approved amount.
//
// THREE FIGURES, NOT ONE, AND NONE OF THEM ROUNDED. A grant approved at one
// amount and paid out in termin has a headroom that decides whether the next
// termin is accepted at all: the engine refuses the termin that would take the
// running total past `jumlah_disetujui` with PLAFON_PENYALURAN_TERLAMPAUI,
// ahead of the deferred TJSL-NPK-002 trigger. A termin landing EXACTLY on the
// ceiling is allowed and one sen over it is not.
//
// That is why "Sisa pagu" on this page is the server's own NUMERIC(20,2)
// rendered through `formatMoney` with two decimals and no rounding of any
// kind, and why the check in this file runs through `bandingUang`, in integer
// sen, against that same figure. A remaining ceiling shown to the nearest
// rupiah would hide the sen that decides the refusal, and an operator who
// typed the remaining figure they read off the screen would be refused by the
// server for a reason the screen had made invisible.
//
// FAILS CLOSED. The button needs the detail read to have SUCCEEDED for this
// proposal: the ceiling and the running total both come from it, and there is
// no second source for either. `bandingUang` answering null, which is what a
// figure it cannot read produces, closes the button too. Not comparable is not
// the same as within the limit.
//
// IT RECORDS, IT DOES NOT PAY. What this page produces is a termin row and the
// PENYALURAN_NON_PUMK journal that recognises it. The money left the counter
// or the bank before anyone opened this screen.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  DataTable,
  ErrorState,
  Field,
  Icon,
  MoneyInput,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
  bandingUang,
  formatCount,
  formatDate,
  formatMoney,
  formatTotal,
  Tabs,
  TabPanel,
  type Column,
} from "@krakatausteel/ui";
import {
  catatPenyaluran,
  daftarAkunBeban,
  detailProposal,
  tutupPenyaluran,
  type DetailProposalNonPumk,
  type Penyaluran as TerminPenyaluran,
} from "../../api/nonpumk";
import { daftarAkunKas } from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import {
  Bagian,
  BarisAksi,
  CatatanOtorisasi,
  CatatanPencatatan,
  FieldGrid,
  HalamanModul,
  hariIni,
  KembaliKeAntrean,
  Muat,
  usePilihan,
} from "../shared/parts";
import { Antrean, Pagu, RingkasProgram } from "./parts";

const KOLOM_TERMIN: readonly Column<TerminPenyaluran>[] = [
  { key: "termin", header: "Termin", type: "count", width: "90px" },
  { key: "tanggalPenyaluran", header: "Tanggal", type: "date", width: "130px" },
  { key: "jumlah", header: "Jumlah", type: "money", width: "160px" },
  {
    key: "noBukti",
    header: "No bukti",
    width: "150px",
    render: (row) => row.noBukti ?? "Tidak diisi",
  },
  {
    key: "keterangan",
    header: "Keterangan",
    render: (row) => <span className="sel-ringkas">{row.keterangan ?? "Tidak diisi"}</span>,
  },
];

export function Penyaluran({ route }: { route: PageRoute }) {
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");
  const [tabAntrean, setTabAntrean] = useState("DISETUJUI");

  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const akunKas = useApi(() => daftarAkunKas(), []);
  const akunBeban = useApi(() => daftarAkunBeban(), []);

  const [tanggal, setTanggal] = useState(hariIni());
  const [jumlah, setJumlah] = useState("");
  const [jumlahTerbaca, setJumlahTerbaca] = useState(true);
  const [kas, setKas] = useState("");
  const [beban, setBeban] = useState("");
  const [noBukti, setNoBukti] = useState("");
  const [keterangan, setKeterangan] = useState("");
  const [konfirmasi, setKonfirmasi] = useState(false);
  const [konfirmasiTutup, setKonfirmasiTutup] = useState(false);
  const [catatanTutup, setCatatanTutup] = useState("");

  const simpan = useAction(catatPenyaluran);
  // `tutupPenyaluran` takes two arguments and `useAction` runs one input, so
  // the pair is named here rather than positional at the call site.
  const tutup = useAction((input: { proposalId: string; catatan: string | null }) =>
    tutupPenyaluran(input.proposalId, input.catatan),
  );

  const kasOptions = [
    { value: "", label: "Pilih akun kas atau bank" },
    ...(akunKas.data?.data ?? []).map((item) => ({
      value: item.id,
      label: `${item.kode} ${item.nama}`,
    })),
  ];
  const bebanOptions = [
    { value: "", label: "Pilih akun beban penyaluran" },
    ...(akunBeban.data?.data ?? []).map((item) => ({
      value: item.id,
      label: `${item.kode} ${item.nama}`,
    })),
  ];

  if (proposalId === null) {
    return (
      <HalamanModul route={route}>
        <Tabs
          label="Tahap penyaluran"
          active={tabAntrean}
          onChange={setTabAntrean}
          items={[
            { id: "DISETUJUI", label: "Siap disalurkan" },
            { id: "DISALURKAN", label: "Penyaluran berjalan" },
          ]}
          aside={
            <span className="tabs-note">
              Termin kedua dan seterusnya dicatat dari tab Penyaluran berjalan.
            </span>
          }
        />
        <TabPanel id={tabAntrean}>
          {tabAntrean === "DISETUJUI" ? (
            <Antrean
              status="DISETUJUI"
              title="Siap disalurkan"
              description="Program yang sudah disetujui Approver dan belum menerima termin pertama."
              emptyTitle="Tidak ada program yang siap disalurkan"
              emptyDescription="Program masuk ke antrean ini setelah Approver menyetujuinya beserta nilai pagunya."
              onPilih={(row) => setProposalId(row.id)}
            />
          ) : (
            <Antrean
              status="DISALURKAN"
              title="Penyaluran berjalan"
              description="Program yang sudah menerima satu termin atau lebih dan masih memiliki sisa pagu."
              emptyTitle="Tidak ada penyaluran yang sedang berjalan"
              emptyDescription="Program muncul di sini setelah termin pertamanya tercatat."
              emptyIcon="wallet"
              onPilih={(row) => setProposalId(row.id)}
            />
          )}
        </TabPanel>
        <CatatanPencatatan />
        <CatatanOtorisasi />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul route={route} back={{ to: "/nonpumk/penyaluran", label: "Antrean penyaluran" }}>
      <Muat
        hasil={detail}
        judul="pagu dan riwayat penyaluran"
        sumber={`GET /api/nonpumk/proposal/${proposalId}`}
      >
        {(data: DetailProposalNonPumk) => {
          const { proposal } = data;

          // Both figures come from the server. Nothing here recomputes the
          // running total from the termin rows: the engine's own SUM is the
          // one the ceiling check uses, and a second addition in the browser
          // would be a second answer.
          const sisaPagu = data.sisaPagu;
          const cukup = jumlah === "" ? null : bandingUang(jumlah, sisaPagu);
          const melebihiPagu = cukup === null ? null : cukup > 0;
          const tepatPagu = cukup === 0;

          const referensiSiap = akunKas.status === "siap" && akunBeban.status === "siap";
          const lengkap =
            jumlah !== "" &&
            jumlahTerbaca &&
            kas !== "" &&
            beban !== "" &&
            tanggal !== "" &&
            melebihiPagu === false;
          const bolehSimpan = lengkap && referensiSiap;

          async function catat() {
            if (!proposalId || !bolehSimpan) return;
            const hasil = await simpan.jalankan({
              proposalId,
              tanggalPenyaluran: tanggal,
              jumlah,
              akunKasId: kas,
              akunBebanId: beban,
              noBukti: noBukti.trim() || null,
              keterangan: keterangan.trim() || null,
            });
            if (hasil) {
              setKonfirmasi(false);
              setJumlah("");
              setNoBukti("");
              setKeterangan("");
              detail.reload();
            }
          }

          async function tutupStaging() {
            if (!proposalId) return;
            const hasil = await tutup.jalankan({
              proposalId,
              catatan: catatanTutup.trim() || null,
            });
            if (hasil) {
              setKonfirmasiTutup(false);
              navigate(`/nonpumk/proposal/${proposalId}`);
            }
          }

          return (
            <>
              <RingkasProgram
                proposal={proposal}
                bidangNama={data.bidangNama}
                cabangNama={data.cabangNama}
                sdg={data.sdg}
              />

              <Pagu
                disetujui={proposal.jumlahDisetujui}
                disalurkan={data.totalDisalurkan}
                sisa={sisaPagu}
                catatanSisa="Angka penuh sampai satuan sen, tanpa pembulatan. Termin yang persis sebesar sisa ini diterima, satu sen lebih ditolak."
                status={
                  <StatusBadge
                    status={bandingUang(sisaPagu, "0.00") === 0 ? "PAGU_HABIS" : "PAGU_TERSISA"}
                    tone={bandingUang(sisaPagu, "0.00") === 0 ? "neutral" : "success"}
                    label={
                      bandingUang(sisaPagu, "0.00") === 0 ? "Pagu habis" : "Masih ada sisa pagu"
                    }
                  />
                }
              />

              <div className="form-layout has-aside">
                <div className="form-main">
                  <Bagian
                    title="Termin penyaluran"
                    description="Satu termin per pencatatan. Nilai termin tidak boleh melebihi sisa pagu, dan boleh persis sama dengan sisa pagu."
                    aside={
                      <span className="tabs-note">
                        Termin berikutnya nomor {formatCount(data.penyaluran.length + 1)}
                      </span>
                    }
                  >
                    <FieldGrid>
                      <Field label="Tanggal penyaluran" htmlFor="np-tanggal-salur" required>
                        <TextInput
                          id="np-tanggal-salur"
                          type="date"
                          value={tanggal}
                          onChange={(event) => setTanggal(event.currentTarget.value)}
                        />
                      </Field>
                      <Field
                        label="Jumlah termin"
                        htmlFor="np-jumlah-salur"
                        required
                        error={
                          !jumlahTerbaca
                            ? "Nilai tidak terbaca sebagai angka rupiah."
                            : melebihiPagu === true
                              ? `Melebihi sisa pagu ${formatMoney(sisaPagu)}.`
                              : melebihiPagu === null && jumlah !== ""
                                ? "Nilai termin tidak dapat dibandingkan dengan sisa pagu."
                                : undefined
                        }
                        hint={
                          tepatPagu
                            ? "Termin ini persis menghabiskan sisa pagu, dan itu diperbolehkan."
                            : `Sisa pagu saat ini ${formatMoney(sisaPagu)}.`
                        }
                      >
                        <MoneyInput
                          id="np-jumlah-salur"
                          value={jumlah}
                          invalid={!jumlahTerbaca || melebihiPagu !== false}
                          onValueChange={(value, raw) => {
                            setJumlah(value ?? "");
                            setJumlahTerbaca(raw.trim() === "" || value !== null);
                          }}
                        />
                      </Field>
                      <Field
                        label="Akun kas atau bank"
                        htmlFor="np-akun-kas"
                        required
                        hint={
                          akunKas.status === "gagal"
                            ? "Daftar akun kas tidak dapat dibaca dari server, jadi penyaluran tidak bisa disimpan."
                            : "Hanya akun berflag kas yang muncul di sini."
                        }
                      >
                        <Select
                          id="np-akun-kas"
                          value={kas}
                          disabled={akunKas.status !== "siap"}
                          onChange={(event) => setKas(event.currentTarget.value)}
                          options={kasOptions}
                        />
                      </Field>
                      <Field
                        label="Akun beban penyaluran"
                        htmlFor="np-akun-beban"
                        required
                        hint={
                          akunBeban.status === "gagal"
                            ? "Daftar akun beban tidak dapat dibaca dari server, jadi penyaluran tidak bisa disimpan."
                            : "Beban penyaluran Non PUMK per bidang, dipakai sebagai sisi debit jurnal."
                        }
                      >
                        <Select
                          id="np-akun-beban"
                          value={beban}
                          disabled={akunBeban.status !== "siap"}
                          onChange={(event) => setBeban(event.currentTarget.value)}
                          options={bebanOptions}
                        />
                      </Field>
                      <Field label="Nomor bukti" htmlFor="np-no-bukti">
                        <TextInput
                          id="np-no-bukti"
                          value={noBukti}
                          onChange={(event) => setNoBukti(event.currentTarget.value)}
                        />
                      </Field>
                    </FieldGrid>
                    <Field label="Keterangan" htmlFor="np-keterangan-salur">
                      <Textarea
                        id="np-keterangan-salur"
                        rows={2}
                        value={keterangan}
                        onChange={(event) => setKeterangan(event.currentTarget.value)}
                      />
                    </Field>

                    <BarisAksi
                      error={simpan.error}
                      secondary={<KembaliKeAntrean onClick={() => setProposalId(null)} />}
                      primary={
                        <Button
                          variant="primary"
                          disabled={!bolehSimpan}
                          loading={simpan.status === "mengirim"}
                          loadingLabel="Menyimpan"
                          onClick={() => setKonfirmasi(true)}
                        >
                          Catat termin penyaluran
                        </Button>
                      }
                    />
                  </Bagian>

                </div>

                <aside className="form-aside">
                  {!referensiSiap && (akunKas.status === "gagal" || akunBeban.status === "gagal") ? (
                    <ErrorState
                      title="Daftar akun tidak dapat dibaca"
                      description="Penyaluran sengaja ditutup: tanpa akun kas dan akun beban dari server, jurnal penyalurannya tidak dapat dibentuk dengan benar."
                      detail={akunKas.error ?? akunBeban.error}
                      sumber="GET /api/konfigurasi/akun?kas=true dan GET /api/nonpumk/akun-beban"
                      onRetry={() => {
                        akunKas.reload();
                        akunBeban.reload();
                      }}
                    />
                  ) : null}

                  <Panel
                    as="h2"
                    title="Yang terjadi setelah disimpan"
                    footer={<span>Jurnal dibentuk lewat event mapping, bukan diketik manual.</span>}
                  >
                    <ol className="langkah-list">
                      <li>Termin tercatat pada program ini beserta nomor bukti dan akun kasnya.</li>
                      <li>
                        Jurnal PENYALURAN_NON_PUMK terbentuk, mendebit akun beban penyaluran bidang
                        {` ${data.bidangNama}`} dan mengkredit akun kas yang dipilih.
                      </li>
                      <li>Status program menjadi Disalurkan dan sisa pagu berkurang.</li>
                      <li>
                        Selama penyaluran belum ditutup, jam LPJ belum berjalan dan program belum
                        muncul pada monitoring keterlambatan.
                      </li>
                    </ol>
                  </Panel>

                  <Panel
                    as="h2"
                    title="Tutup penyaluran"
                    description="Menyatakan tidak akan ada termin lagi. Sejak saat itu jam LPJ berjalan, dihitung dari termin terakhir."
                    footer={
                      <span>
                        Sisa pagu yang belum disalurkan tidak hangus secara akuntansi, tetapi tidak
                        dapat lagi disalurkan pada program ini.
                      </span>
                    }
                  >
                    <DataList
                      items={[
                        {
                          label: "Termin tercatat",
                          value: formatCount(data.penyaluran.length),
                          numeric: true,
                        },
                        {
                          label: "Sisa pagu belum disalurkan",
                          value: formatMoney(sisaPagu),
                          numeric: true,
                        },
                      ]}
                    />
                    <Field
                      label="Catatan penutupan"
                      htmlFor="np-catatan-tutup"
                      hint="Tersimpan pada timeline program sebagai alasan penutupan."
                    >
                      <Textarea
                        id="np-catatan-tutup"
                        rows={2}
                        value={catatanTutup}
                        onChange={(event) => setCatatanTutup(event.currentTarget.value)}
                      />
                    </Field>
                    <BarisAksi
                      error={tutup.error}
                      primary={
                        <Button
                          variant="secondary"
                          disabled={data.penyaluran.length === 0}
                          loading={tutup.status === "mengirim"}
                          loadingLabel="Menutup"
                          leading={<Icon name="lock" size={16} />}
                          onClick={() => setKonfirmasiTutup(true)}
                        >
                          Tutup penyaluran
                        </Button>
                      }
                    />
                  </Panel>
                </aside>
              </div>

        <Panel
          as="h2"
          title="Riwayat termin"
          description="Seluruh termin yang sudah tercatat pada program ini, beserta jurnalnya."
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
              emptyDescription="Termin pertama tercatat setelah penyaluran dilakukan dan disimpan pada halaman ini."
            />
          </div>
          <div className="daftar-kartu">
            {data.penyaluran.length === 0 ? (
              <p className="penjelasan">
                Belum ada termin yang tercatat pada program ini.
              </p>
            ) : (
              <ul className="kartu-list">
                {data.penyaluran.map((row) => (
                  <li className="kartu-item" key={row.id}>
                    <span className="kartu-btn is-statis">
                      <span className="kartu-head">
                        <span className="kartu-judul">
                          Termin {formatCount(row.termin)}
                        </span>
                      </span>
                      <span className="kartu-sub">
                        {formatDate(row.tanggalPenyaluran)} .{" "}
                        {row.noBukti ?? "Tanpa nomor bukti"}
                      </span>
                      <span className="kartu-foot">
                        <span className="kartu-meta">{row.keterangan ?? ""}</span>
                        <span className="kartu-nilai">
                          <span className="kartu-nilai-label">Jumlah</span>
                          <span className="kartu-nilai-val">
                            {formatMoney(row.jumlah)}
                          </span>
                        </span>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>

              <ConfirmDialog
                open={konfirmasi}
                title="Konfirmasi pencatatan termin"
                description="Aplikasi mencatat penyaluran yang sudah terjadi di kas atau bank. Penyimpanan ini membentuk jurnal, bukan memindahkan dana."
                confirmLabel="Catat termin"
                loading={simpan.status === "mengirim"}
                error={simpan.error}
                onCancel={() => setKonfirmasi(false)}
                onConfirm={catat}
              >
                <DataList
                  items={[
                    { label: "Proposal", value: proposal.noProposal },
                    { label: "Pemohon", value: proposal.namaPemohon },
                    { label: "Termin ke", value: formatCount(data.penyaluran.length + 1), numeric: true },
                    { label: "Tanggal", value: formatDate(tanggal) },
                    { label: "Jumlah termin", value: formatMoney(jumlah), numeric: true },
                    { label: "Sisa pagu sebelum", value: formatMoney(sisaPagu), numeric: true },
                    { label: "Nomor bukti", value: noBukti.trim() || "Tidak diisi" },
                  ]}
                />
              </ConfirmDialog>

              <ConfirmDialog
                open={konfirmasiTutup}
                title="Konfirmasi penutupan penyaluran"
                description="Setelah ditutup, tidak ada termin baru yang dapat dicatat pada program ini dan jam LPJ mulai berjalan dari tanggal termin terakhir. Tindakan ini tidak dapat dibatalkan dari halaman mana pun."
                confirmLabel="Tutup penyaluran"
                tone="danger"
                confirmPhrase="TUTUP PENYALURAN"
                loading={tutup.status === "mengirim"}
                error={tutup.error}
                onCancel={() => setKonfirmasiTutup(false)}
                onConfirm={tutupStaging}
              >
                <DataList
                  items={[
                    { label: "Proposal", value: proposal.noProposal },
                    { label: "Nilai disetujui", value: proposal.jumlahDisetujui === null ? "Belum disetujui" : formatMoney(proposal.jumlahDisetujui), numeric: true },
                    { label: "Sudah disalurkan", value: formatMoney(data.totalDisalurkan), numeric: true },
                    { label: "Sisa pagu tidak disalurkan", value: formatMoney(sisaPagu), numeric: true },
                  ]}
                />
              </ConfirmDialog>
            </>
          );
        }}
      </Muat>
      <CatatanPencatatan />
      <CatatanOtorisasi tambahan="Batas pagu ditegakkan oleh engine dan oleh trigger basis data, terlepas dari apa yang ditampilkan halaman ini." />
    </HalamanModul>
  );
}
