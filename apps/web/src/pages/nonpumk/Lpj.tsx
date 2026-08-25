// Laporan Pertanggungjawaban Non PUMK, spec 9.2. Filing, acceptance and
// rejection on one screen, because they are three moves on the same document
// and an operator who opens "LPJ" is looking for whichever of them is due.
//
// THREE FIGURES, NOT ONE. When the realisation is smaller than what was
// disbursed, the difference has to come back. A page that showed only the
// realisation would leave the most consequential number of the three off the
// screen entirely, so "Dana disalurkan", "Realisasi LPJ" and "Sisa
// dikembalikan" are printed side by side, at full precision, on both halves of
// this page.
//
// THE REMAINDER PRODUCES A JOURNAL, AND ONLY ON ACCEPTANCE. Filing posts
// nothing: an LPJ that can still be rejected must not have moved the ledger,
// or every routine rejection would need a reversal. The money comes back when
// the LPJ is ACCEPTED, and then PENGEMBALIAN_SISA_NON_PUMK is posted for the
// remainder and only for the remainder. With a remainder of zero no journal is
// created at all, because an empty balanced pair in the buku besar is noise an
// auditor has to explain. Both halves of that rule are on screen.
//
// WHILE FILING, the remainder shown is computed here from the SERVER's
// disbursed total minus the typed realisation, in integer sen, so it is the
// same subtraction the engine will do. The engine's answer is the one that is
// stored; this one exists so nobody submits a figure whose consequence they
// could not see. Once the LPJ exists, the remainder shown is the engine's own.
//
// VERIFICATION IS THE CHECKER'S, AND THE ORDINARY PERMISSION CHECK DECIDES.
// It requires `nonpumk.lpj.verifikasi`, which is its own code so that the
// Maker who filed the report cannot also sign it off. A session that holds it
// verifies against the real endpoint; a session that does not gets the
// disabled controls every other action on these screens uses.
//
// An earlier version of this file told the reader that the permission "belum
// terdaftar pada katalog hak akses sistem". That was FALSE: it is in the
// server's catalogue and granted to CHECKER. A Checker who genuinely held the
// right was being told by the application that the feature did not exist, and
// they had no way to know better. The application must not make claims about
// its own configuration that it cannot see; it can only report what THIS
// session carries.
import { useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataList,
  ErrorState,
  Field,
  MoneyInput,
  Panel,
  Select,
  StatusBadge,
  Tabs,
  TabPanel,
  Textarea,
  TextInput,
  bandingUang,
  formatCount,
  formatDate,
  formatMoney,
  kurangkanUang,
} from "@krakatausteel/ui";
import {
  ajukanLpj,
  detailProposal,
  tolakLpj,
  verifikasiLpj,
  type DetailProposalNonPumk,
} from "../../api/nonpumk";
import { daftarAkunKas } from "../../api/pumk";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { hasPermission } from "../../permissions";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
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
import { Antrean, Peringatan, RingkasProgram, Sisa } from "./parts";

export function Lpj({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { navigate } = useRouter();
  const [proposalId, setProposalId] = usePilihan("proposal");
  const [tabAntrean, setTabAntrean] = useState("MENUNGGU_LPJ");

  const detail = useApi(() => detailProposal(proposalId ?? ""), [proposalId], {
    enabled: proposalId !== null,
  });
  const akunKas = useApi(() => daftarAkunKas(), []);

  const [tanggalLpj, setTanggalLpj] = useState(hariIni());
  const [realisasi, setRealisasi] = useState("");
  const [realisasiTerbaca, setRealisasiTerbaca] = useState(true);
  const [penerima, setPenerima] = useState("");
  const [uraian, setUraian] = useState("");
  const [konfirmasiAjukan, setKonfirmasiAjukan] = useState(false);

  const [tanggalVerifikasi, setTanggalVerifikasi] = useState(hariIni());
  const [kas, setKas] = useState("");
  const [catatanVerifikasi, setCatatanVerifikasi] = useState("");
  const [catatanTolak, setCatatanTolak] = useState("");
  const [konfirmasiTerima, setKonfirmasiTerima] = useState(false);
  const [konfirmasiTolak, setKonfirmasiTolak] = useState(false);

  const kirimLpj = useAction(ajukanLpj);
  const terima = useAction(verifikasiLpj);
  const tolak = useAction(tolakLpj);

  const bolehVerifikasi = hasPermission(session.permissions, "nonpumk.lpj.verifikasi");

  const kasOptions = [
    { value: "", label: "Pilih akun kas atau bank penerima pengembalian" },
    ...(akunKas.data?.data ?? []).map((item) => ({
      value: item.id,
      label: `${item.kode} ${item.nama}`,
    })),
  ];

  if (proposalId === null) {
    return (
      <HalamanModul route={route}>
        <Tabs
          label="Tahap LPJ"
          active={tabAntrean}
          onChange={setTabAntrean}
          items={[
            { id: "MENUNGGU_LPJ", label: "Menunggu LPJ" },
            { id: "LPJ_DIAJUKAN", label: "Menunggu verifikasi" },
            { id: "LPJ_DITOLAK", label: "LPJ ditolak" },
          ]}
          aside={
            <span className="tabs-note">
              Setiap tab adalah satu status, dibaca dari server satu per satu.
            </span>
          }
        />
        <TabPanel id={tabAntrean}>
          {tabAntrean === "MENUNGGU_LPJ" ? (
            <Antrean
              status="MENUNGGU_LPJ"
              title="Menunggu LPJ"
              description="Program yang penyalurannya sudah ditutup dan LPJ nya belum masuk."
              emptyTitle="Tidak ada program yang menunggu LPJ"
              emptyDescription="Program masuk ke antrean ini setelah penyalurannya ditutup."
              onPilih={(row) => setProposalId(row.id)}
            />
          ) : tabAntrean === "LPJ_DIAJUKAN" ? (
            <Antrean
              status="LPJ_DIAJUKAN"
              title="Menunggu verifikasi"
              description="LPJ yang sudah diajukan penerima dan menunggu keputusan terima atau tolak."
              emptyTitle="Tidak ada LPJ yang menunggu verifikasi"
              emptyDescription="LPJ muncul di sini setelah penerima bantuan mengajukannya."
              emptyIcon="file"
              onPilih={(row) => setProposalId(row.id)}
            />
          ) : (
            <Antrean
              status="LPJ_DITOLAK"
              title="LPJ ditolak"
              description="LPJ yang dikembalikan untuk diperbaiki dan diajukan ulang."
              emptyTitle="Tidak ada LPJ yang ditolak"
              emptyDescription="LPJ yang ditolak muncul di sini beserta catatan penolakannya."
              emptyIcon="history"
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
    <HalamanModul route={route} back={{ to: "/nonpumk/lpj", label: "Antrean LPJ" }}>
      <Muat hasil={detail} judul="data LPJ" sumber={`GET /api/nonpumk/proposal/${proposalId}`}>
        {(data: DetailProposalNonPumk) => {
          const { proposal, lpj } = data;
          const tahapVerifikasi = proposal.status === "LPJ_DIAJUKAN";

          // While filing: our own subtraction, in sen, so the consequence of
          // the typed figure is visible before it is sent. Once the row
          // exists, the engine's own computed remainder, which is the one that
          // is stored and the one that decides whether a journal is posted.
          const sisaDiketik =
            realisasi === "" ? null : kurangkanUang(data.totalDisalurkan, realisasi);
          const realisasiMelebihi =
            realisasi === "" ? null : bandingUang(realisasi, data.totalDisalurkan);
          const sisaTersimpan = lpj?.jumlahSisaDikembalikan ?? null;
          // No `?? something` on this line, deliberately. `bandingUang` already
          // answers null for a figure it cannot read, and any default here
          // would turn "I could not compare these" into a decision about
          // whether money has to come back.
          const adaPengembalian =
            sisaTersimpan === null ? null : bandingUang(sisaTersimpan, "0.00");
          const perluAkunKas = adaPengembalian !== null && adaPengembalian > 0;

          const penerimaAngka = Number(penerima);
          const penerimaSah = penerima !== "" && Number.isInteger(penerimaAngka) && penerimaAngka >= 0;
          const bolehAjukan =
            realisasi !== "" &&
            realisasiTerbaca &&
            realisasiMelebihi !== null &&
            realisasiMelebihi <= 0 &&
            penerimaSah &&
            tanggalLpj !== "";

          const kasSiap = akunKas.status === "siap";
          const bolehTerima =
            bolehVerifikasi &&
            lpj !== null &&
            adaPengembalian !== null &&
            tanggalVerifikasi !== "" &&
            (!perluAkunKas || (kasSiap && kas !== ""));

          async function ajukan() {
            if (!proposalId || !bolehAjukan) return;
            const hasil = await kirimLpj.jalankan({
              proposalId,
              tanggalLpj,
              jumlahRealisasi: realisasi,
              penerimaManfaatAktual: penerimaAngka,
              uraianRealisasi: uraian.trim() || null,
            });
            if (hasil) {
              setKonfirmasiAjukan(false);
              detail.reload();
            }
          }

          async function terimaLpj() {
            if (!proposalId || !bolehTerima) return;
            const hasil = await terima.jalankan({
              proposalId,
              tanggalVerifikasi,
              akunKasId: perluAkunKas ? kas : null,
              catatan: catatanVerifikasi.trim() || null,
            });
            if (hasil) {
              setKonfirmasiTerima(false);
              navigate(`/nonpumk/proposal/${proposalId}`);
            }
          }

          async function tolakLpjSekarang() {
            if (!proposalId || catatanTolak.trim() === "") return;
            const hasil = await tolak.jalankan({
              proposalId,
              tanggal: hariIni(),
              catatan: catatanTolak.trim(),
            });
            if (hasil) {
              setKonfirmasiTolak(false);
              detail.reload();
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

              <Sisa
                disalurkan={data.totalDisalurkan}
                realisasi={tahapVerifikasi ? (lpj?.jumlahRealisasi ?? null) : realisasi || null}
                sisa={tahapVerifikasi ? sisaTersimpan : sisaDiketik}
                catatanSisa={
                  tahapVerifikasi
                    ? "Dihitung engine sebagai dana disalurkan dikurangi realisasi. Sisa di atas nol membentuk jurnal pengembalian saat LPJ diterima."
                    : "Dihitung dalam satuan sen dari nilai yang sedang diketik. Nilai yang disimpan adalah hasil hitungan engine."
                }
                status={
                  adaPengembalian === null ? undefined : (
                    <StatusBadge
                      status={adaPengembalian > 0 ? "ADA_PENGEMBALIAN" : "TANPA_PENGEMBALIAN"}
                      tone={adaPengembalian > 0 ? "warning" : "success"}
                      label={adaPengembalian > 0 ? "Ada pengembalian" : "Tanpa pengembalian"}
                    />
                  )
                }
              />

              {proposal.status === "LPJ_DITOLAK" ? (
                <Peringatan judul="LPJ sebelumnya ditolak">
                  LPJ program ini dikembalikan untuk diperbaiki. Pengajuan ulang memperbarui baris
                  LPJ yang sama, dan alasan penolakannya tersimpan pada timeline program.
                </Peringatan>
              ) : null}

              {tahapVerifikasi ? (
                <div className="form-layout has-aside">
                  <div className="form-main">
                    {!bolehVerifikasi ? (
                      <Peringatan judul="Verifikasi LPJ bukan wewenang akun ini">
                        Menerima atau menolak LPJ adalah wewenang Checker, terpisah dari hak
                        mengajukan LPJ, agar pelapor tidak menyetujui laporannya sendiri. Tombol
                        terima dan tolak ditutup untuk akun Anda.
                      </Peringatan>
                    ) : null}

                    <Bagian
                      title="Isi LPJ yang diajukan"
                      description="Angka di bawah berasal dari LPJ yang diajukan penerima bantuan dan tidak dapat diubah dari halaman ini."
                      aside={lpj ? <StatusBadge status={`LPJ_${lpj.status}`} label="Diajukan" tone="info" /> : undefined}
                      footer={
                        <span>
                          Sisa yang wajib dikembalikan dihitung engine, bukan diketik pelapor, agar
                          kedua angkanya tidak dapat berselisih.
                        </span>
                      }
                    >
                      {lpj ? (
                        <DataList
                          columns={2}
                          items={[
                            { label: "Tanggal LPJ", value: formatDate(lpj.tanggalLpj) },
                            {
                              label: "Penerima manfaat aktual",
                              value:
                                lpj.penerimaManfaatAktual === null
                                  ? "Belum diisi"
                                  : formatCount(lpj.penerimaManfaatAktual),
                              numeric: true,
                            },
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
                              label: "Estimasi penerima manfaat",
                              value:
                                proposal.penerimaManfaatEstimasi === null
                                  ? "Belum diisi"
                                  : formatCount(proposal.penerimaManfaatEstimasi),
                              numeric: true,
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
                          Status program menyatakan LPJ sudah diajukan, tetapi baris LPJ nya tidak
                          terbaca pada data ini. Verifikasi tetap tertutup sampai isinya dapat
                          ditampilkan.
                        </p>
                      )}
                    </Bagian>

                    <Bagian
                      title="Keputusan verifikasi"
                      description="Menerima LPJ menutup program. Bila ada sisa, penerimaan inilah yang membentuk jurnal pengembalian sisa."
                      footer={
                        <span>
                          {perluAkunKas
                            ? "Akun kas wajib diisi karena terdapat sisa yang harus kembali."
                            : "Tidak ada sisa, jadi tidak ada jurnal pengembalian dan akun kas tidak diperlukan."}
                        </span>
                      }
                    >
                      <FieldGrid>
                        <Field label="Tanggal verifikasi" htmlFor="np-tanggal-verifikasi" required>
                          <TextInput
                            id="np-tanggal-verifikasi"
                            type="date"
                            value={tanggalVerifikasi}
                            disabled={!bolehVerifikasi}
                            onChange={(event) => setTanggalVerifikasi(event.currentTarget.value)}
                          />
                        </Field>
                        <Field
                          label="Akun kas penerima pengembalian"
                          htmlFor="np-akun-kas-lpj"
                          required={perluAkunKas}
                          hint={
                            !perluAkunKas
                              ? "Tidak diperlukan: realisasi sama dengan dana yang disalurkan."
                              : akunKas.status === "gagal"
                                ? "Daftar akun kas tidak dapat dibaca dari server, jadi penerimaan LPJ tidak bisa disimpan."
                                : "Ke mana dana sisa dikembalikan."
                          }
                        >
                          <Select
                            id="np-akun-kas-lpj"
                            value={kas}
                            disabled={!bolehVerifikasi || !perluAkunKas || !kasSiap}
                            onChange={(event) => setKas(event.currentTarget.value)}
                            options={kasOptions}
                          />
                        </Field>
                      </FieldGrid>

                      <Field label="Catatan verifikasi" htmlFor="np-catatan-verifikasi">
                        <Textarea
                          id="np-catatan-verifikasi"
                          rows={2}
                          value={catatanVerifikasi}
                          disabled={!bolehVerifikasi}
                          onChange={(event) => setCatatanVerifikasi(event.currentTarget.value)}
                        />
                      </Field>

                      <Field
                        label="Alasan penolakan"
                        htmlFor="np-catatan-tolak"
                        hint="Wajib bila LPJ ditolak. Tanpa alasan, penerima bantuan tidak tahu apa yang harus diperbaiki."
                      >
                        <Textarea
                          id="np-catatan-tolak"
                          rows={2}
                          value={catatanTolak}
                          disabled={!bolehVerifikasi}
                          onChange={(event) => setCatatanTolak(event.currentTarget.value)}
                        />
                      </Field>

                      <BarisAksi
                        error={terima.error ?? tolak.error}
                        secondary={
                          <Button
                            variant="danger"
                            disabled={!bolehVerifikasi || catatanTolak.trim() === ""}
                            loading={tolak.status === "mengirim"}
                            loadingLabel="Menolak"
                            onClick={() => setKonfirmasiTolak(true)}
                          >
                            Tolak LPJ
                          </Button>
                        }
                        primary={
                          <Button
                            variant="primary"
                            disabled={!bolehTerima}
                            loading={terima.status === "mengirim"}
                            loadingLabel="Menyimpan"
                            onClick={() => setKonfirmasiTerima(true)}
                          >
                            Terima LPJ
                          </Button>
                        }
                      />
                    </Bagian>
                  </div>

                  <aside className="form-aside">
                    {perluAkunKas && akunKas.status === "gagal" ? (
                      <ErrorState
                        title="Daftar akun kas tidak dapat dibaca"
                        description="Penerimaan LPJ sengaja ditutup: ada sisa yang harus dikembalikan, dan tanpa akun kas dari server jurnal pengembaliannya tidak dapat dibentuk."
                        detail={akunKas.error}
                        sumber="GET /api/konfigurasi/akun?kas=true"
                        onRetry={akunKas.reload}
                      />
                    ) : null}

                    <Panel
                      as="h2"
                      title="Jurnal yang akan terbentuk"
                      description="Hanya saat LPJ diterima, dan hanya bila ada sisa."
                      footer={
                        <span>
                          Jurnal dibentuk oleh engine jurnal melalui event mapping, bukan diketik
                          pada halaman ini.
                        </span>
                      }
                    >
                      {adaPengembalian !== null && adaPengembalian > 0 ? (
                        <ol className="langkah-list">
                          <li>
                            PENGEMBALIAN_SISA_NON_PUMK sebesar{" "}
                            {formatMoney(sisaTersimpan ?? "0.00")}, mendebit akun kas yang dipilih.
                          </li>
                          <li>
                            Sisi kredit adalah akun beban penyaluran yang dipakai termin program
                            ini, dibaca engine dari baris terminnya, bukan dipilih di sini.
                          </li>
                          <li>Status program menjadi Selesai.</li>
                        </ol>
                      ) : (
                        <p className="penjelasan">
                          Realisasi sama dengan dana yang disalurkan, sehingga tidak ada sisa yang
                          kembali dan tidak ada jurnal yang terbentuk. Penerimaan LPJ hanya menutup
                          program.
                        </p>
                      )}
                    </Panel>
                  </aside>
                </div>
              ) : (
                <div className="form-layout has-aside">
                  <div className="form-main">
                    <Bagian
                      title="Isi LPJ"
                      description="Realisasi adalah nilai yang benar benar dipakai untuk program, dan boleh lebih kecil dari yang disalurkan. Lebih besar ditolak engine."
                      footer={
                        <span>
                          Pengajuan LPJ belum membentuk jurnal apa pun. Jurnal pengembalian baru
                          terbentuk bila dan ketika LPJ ini diterima verifikator.
                        </span>
                      }
                    >
                      <FieldGrid>
                        <Field label="Tanggal LPJ" htmlFor="np-tanggal-lpj" required>
                          <TextInput
                            id="np-tanggal-lpj"
                            type="date"
                            value={tanggalLpj}
                            onChange={(event) => setTanggalLpj(event.currentTarget.value)}
                          />
                        </Field>
                        <Field
                          label="Nilai realisasi"
                          htmlFor="np-realisasi"
                          required
                          error={
                            !realisasiTerbaca
                              ? "Nilai tidak terbaca sebagai angka rupiah."
                              : realisasiMelebihi !== null && realisasiMelebihi > 0
                                ? `Realisasi melebihi dana yang disalurkan ${formatMoney(data.totalDisalurkan)}.`
                                : realisasiMelebihi === null && realisasi !== ""
                                  ? "Realisasi tidak dapat dibandingkan dengan dana yang disalurkan."
                                  : undefined
                          }
                          hint={`Dana disalurkan ${formatMoney(data.totalDisalurkan)}.`}
                        >
                          <MoneyInput
                            id="np-realisasi"
                            value={realisasi}
                            invalid={
                              !realisasiTerbaca ||
                              (realisasi !== "" &&
                                (realisasiMelebihi === null || realisasiMelebihi > 0))
                            }
                            onValueChange={(value, raw) => {
                              setRealisasi(value ?? "");
                              setRealisasiTerbaca(raw.trim() === "" || value !== null);
                            }}
                          />
                        </Field>
                        <Field
                          label="Penerima manfaat aktual"
                          htmlFor="np-penerima-aktual"
                          required
                          hint={
                            proposal.penerimaManfaatEstimasi === null
                              ? "Jumlah penerima manfaat yang benar benar terlayani."
                              : `Estimasi pada proposal ${formatCount(proposal.penerimaManfaatEstimasi)} orang.`
                          }
                        >
                          <TextInput
                            id="np-penerima-aktual"
                            type="number"
                            min={0}
                            step={1}
                            inputMode="numeric"
                            invalid={penerima !== "" && !penerimaSah}
                            value={penerima}
                            onChange={(event) => setPenerima(event.currentTarget.value)}
                          />
                        </Field>
                      </FieldGrid>

                      <Field label="Uraian realisasi" htmlFor="np-uraian">
                        <Textarea
                          id="np-uraian"
                          rows={4}
                          value={uraian}
                          onChange={(event) => setUraian(event.currentTarget.value)}
                        />
                      </Field>

                      <BarisAksi
                        error={kirimLpj.error}
                        secondary={<KembaliKeAntrean onClick={() => setProposalId(null)} />}
                        primary={
                          <Button
                            variant="primary"
                            disabled={!bolehAjukan}
                            loading={kirimLpj.status === "mengirim"}
                            loadingLabel="Mengirim"
                            onClick={() => setKonfirmasiAjukan(true)}
                          >
                            Ajukan LPJ
                          </Button>
                        }
                      />
                    </Bagian>
                  </div>

                  <aside className="form-aside">
                    <Panel
                      as="h2"
                      title="Kewajiban pengembalian sisa"
                      description="Selisih antara dana yang disalurkan dan realisasi wajib dikembalikan ke kas."
                      footer={
                        <span>
                          Pengembalian dicatat sebagai jurnal atas dana yang benar benar kembali,
                          bukan sebagai perintah membayar.
                        </span>
                      }
                    >
                      <DataList
                        items={[
                          {
                            label: "Dana disalurkan",
                            value: formatMoney(data.totalDisalurkan),
                            numeric: true,
                          },
                          {
                            label: "Realisasi diketik",
                            value: realisasi === "" ? "Belum diisi" : formatMoney(realisasi),
                            numeric: true,
                          },
                          {
                            label: "Sisa wajib kembali",
                            value:
                              sisaDiketik === null ? "Belum dapat dihitung" : formatMoney(sisaDiketik),
                            numeric: true,
                          },
                        ]}
                      />
                      <p className="penjelasan">
                        Angka sisa di atas dihitung halaman ini dalam satuan sen supaya
                        konsekuensinya terlihat sebelum LPJ dikirim. Nilai yang tersimpan adalah
                        hasil hitungan engine atas dua angka yang sama, sehingga keduanya tidak
                        dapat berselisih.
                      </p>
                    </Panel>

                    <Panel
                      as="h2"
                      title="Setelah LPJ diajukan"
                      footer={<span>Satu program memiliki satu baris LPJ, pengajuan ulang memperbaruinya.</span>}
                    >
                      <ol className="langkah-list">
                        <li>Status program menjadi LPJ Diajukan dan menunggu verifikasi.</li>
                        <li>Tidak ada jurnal yang terbentuk pada tahap ini.</li>
                        <li>
                          Verifikator dapat menerima atau menolak LPJ, dan penolakan wajib disertai
                          alasan.
                        </li>
                        <li>
                          Jurnal pengembalian sisa baru terbentuk saat LPJ diterima, dan hanya bila
                          sisanya di atas nol.
                        </li>
                      </ol>
                    </Panel>
                  </aside>
                </div>
              )}

              <ConfirmDialog
                open={konfirmasiAjukan}
                title="Konfirmasi pengajuan LPJ"
                description="LPJ tersimpan atas nama Anda dan memindahkan status program. Pengajuan ini tidak membentuk jurnal apa pun."
                confirmLabel="Ajukan LPJ"
                loading={kirimLpj.status === "mengirim"}
                error={kirimLpj.error}
                onCancel={() => setKonfirmasiAjukan(false)}
                onConfirm={ajukan}
              >
                <DataList
                  items={[
                    { label: "Proposal", value: proposal.noProposal },
                    { label: "Pemohon", value: proposal.namaPemohon },
                    { label: "Tanggal LPJ", value: formatDate(tanggalLpj) },
                    {
                      label: "Dana disalurkan",
                      value: formatMoney(data.totalDisalurkan),
                      numeric: true,
                    },
                    {
                      label: "Realisasi",
                      value: realisasi === "" ? "Belum diisi" : formatMoney(realisasi),
                      numeric: true,
                    },
                    {
                      label: "Sisa wajib kembali",
                      value: sisaDiketik === null ? "Belum dapat dihitung" : formatMoney(sisaDiketik),
                      numeric: true,
                    },
                    {
                      label: "Penerima manfaat aktual",
                      value: penerimaSah ? formatCount(penerimaAngka) : "Belum diisi",
                      numeric: true,
                    },
                  ]}
                />
              </ConfirmDialog>

              <ConfirmDialog
                open={konfirmasiTerima}
                title="Konfirmasi penerimaan LPJ"
                description={
                  adaPengembalian !== null && adaPengembalian > 0
                    ? "Penerimaan ini menutup program dan membentuk jurnal pengembalian sisa atas dana yang sudah kembali ke kas. Aplikasi mencatat pengembalian yang sudah terjadi, bukan memindahkan dana."
                    : "Penerimaan ini menutup program. Tidak ada sisa, sehingga tidak ada jurnal yang terbentuk."
                }
                confirmLabel="Terima LPJ"
                loading={terima.status === "mengirim"}
                error={terima.error}
                onCancel={() => setKonfirmasiTerima(false)}
                onConfirm={terimaLpj}
              >
                <DataList
                  items={[
                    { label: "Proposal", value: proposal.noProposal },
                    { label: "Tanggal verifikasi", value: formatDate(tanggalVerifikasi) },
                    {
                      label: "Dana disalurkan",
                      value: formatMoney(data.totalDisalurkan),
                      numeric: true,
                    },
                    {
                      label: "Realisasi",
                      value: lpj ? formatMoney(lpj.jumlahRealisasi) : "Tidak terbaca",
                      numeric: true,
                    },
                    {
                      label: "Sisa dikembalikan",
                      value: sisaTersimpan === null ? "Tidak terbaca" : formatMoney(sisaTersimpan),
                      numeric: true,
                    },
                    {
                      label: "Akun kas penerima",
                      value: perluAkunKas
                        ? (kasOptions.find((item) => item.value === kas)?.label ?? "Belum dipilih")
                        : "Tidak diperlukan",
                      wide: true,
                    },
                  ]}
                />
              </ConfirmDialog>

              <ConfirmDialog
                open={konfirmasiTolak}
                title="Konfirmasi penolakan LPJ"
                description="Penolakan mengembalikan LPJ kepada penerima bantuan untuk diperbaiki. Alasan penolakan tersimpan pada timeline program."
                confirmLabel="Tolak LPJ"
                tone="danger"
                loading={tolak.status === "mengirim"}
                error={tolak.error}
                onCancel={() => setKonfirmasiTolak(false)}
                onConfirm={tolakLpjSekarang}
              >
                <DataList
                  items={[
                    { label: "Proposal", value: proposal.noProposal },
                    { label: "Pemohon", value: proposal.namaPemohon },
                    {
                      label: "Alasan penolakan",
                      value: catatanTolak.trim() || "Belum diisi",
                      wide: true,
                    },
                  ]}
                />
              </ConfirmDialog>
            </>
          );
        }}
      </Muat>
      <CatatanPencatatan />
      <CatatanOtorisasi tambahan="Verifikasi LPJ memerlukan hak akses tersendiri yang terpisah dari hak mengajukan LPJ, dan dipegang Checker." />
    </HalamanModul>
  );
}
