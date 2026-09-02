// Periode Akuntansi, spec 8.4 and spec 9.3. The month register: every period
// the entity has, what state it is in, who closed it and when, the frozen
// balances a closed month is read from afterwards, and the one place a reopen
// is performed.
//
// THE WHOLE PAGE IS READABLE WITH `admin.closing.view` AND NOTHING ELSE. That
// is the Auditor's code, it can run nothing, and spec 16 scenario 23 makes this
// register their primary object: how a month was closed, by whom, against which
// checklist, and what figures were frozen. Every write control on the page is
// gated separately, and the server checks each one again.
//
// REOPEN IS THE HEAVIEST PRIVILEGE IN THE SYSTEM, and the page says so rather
// than implying it with a red button. Closing a month is an operational act;
// reopening one rewrites a month that has already been reported on and DELETES
// its frozen balances. Four things gate it and the screen names all four: the
// `admin.periode.reopen` code that spec 2 gives to Admin Pusat and to nobody
// else, a written reason, the `akuntansi.izinkan_reopen_periode` policy, and
// the target being the LATEST closed period. The confirmation states what will
// happen and requires the operator to type a phrase, because a destructive
// click must not be a reflex on a muscle-memory Enter.
//
// THE FROZEN BALANCES ARE EVIDENCE, NOT A REPORT. They are read from
// `saldo_akun_periode` exactly as they were written at closing (invariant 14),
// which is why a reprint of a past month reproduces them and why a later edit
// to master data cannot move them. A CLOSED period holding ZERO of them is a
// real and reportable state, not an empty table, so the page says which one it
// is looking at.
import { useState } from "react";
import {
  Bento,
  BentoItem,
  Button,
  ConfirmDialog,
  DataList,
  DataTable,
  Field,
  Icon,
  Select,
  StatusBadge,
  Textarea,
  formatCount,
  formatDate,
  formatPeriode,
  type Column,
} from "@krakatausteel/ui";
import {
  bukaKembaliPeriode,
  daftarPeriodeClosing,
  referensiClosing,
  saldoPeriodeClosing,
  MIN_ALASAN_REOPEN,
  MAX_ALASAN_REOPEN,
  type OpsiPeriodeClosing,
  type ReferensiClosing,
  type SaldoAkunPeriode,
  type StatusPeriode,
} from "../../api/closing";
import { useAction, useApi } from "../../api/useApi";
import type { PageRoute } from "../../nav";
import { useRouter } from "../../router";
import { useActiveSession } from "../../session";
import {
  AntreanKosong,
  CatatanOtorisasi,
  DaftarDokumen,
  HalamanModul,
  Muat,
  Penyaring,
  useLayarKecil,
  type ColumnSpec,
} from "../shared/parts";
import {
  KartuKebijakan,
  LABEL_STATUS_PERIODE,
  NilaiUang,
  PanelSumber,
  TanpaWewenang,
  teksUang,
  useFaktaPeriode,
} from "./parts";

const SEMUA_STATUS = "SEMUA";
const FRASA_REOPEN = "BUKA KEMBALI";

export function PeriodeAkuntansi({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const { query, setQuery } = useRouter();
  const kecil = useLayarKecil();

  const bolehReopen = session.permissions.includes("admin.periode.reopen");

  const tahunUrl = Number(query.get("tahun"));
  const tahun =
    Number.isInteger(tahunUrl) && tahunUrl >= 2000 && tahunUrl <= 2100 ? tahunUrl : null;
  const statusUrl = query.get("status");
  const status: StatusPeriode | null =
    statusUrl === "OPEN" || statusUrl === "CLOSING_IN_PROGRESS" || statusUrl === "CLOSED"
      ? statusUrl
      : null;

  const referensi = useApi(() => referensiClosing(), []);
  const daftar = useApi(() => daftarPeriodeClosing({ tahun, status }), [tahun, status]);

  const baris = daftar.data?.data ?? [];
  const periodeUrl = query.get("periode");
  const periodeId =
    periodeUrl && baris.some((p) => p.id === periodeUrl) ? periodeUrl : (baris[0]?.id ?? null);
  const periode = baris.find((p) => p.id === periodeId) ?? null;

  const tahunOpsi = [session.periode.tahun + 1, session.periode.tahun, session.periode.tahun - 1];

  const kontrol = (
    <div className="filter-laporan">
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Tahun buku</span>
        <Select
          aria-label="Tahun buku"
          value={tahun === null ? "" : String(tahun)}
          onChange={(event) => setQuery("tahun", event.currentTarget.value)}
          options={[
            { value: "", label: "Semua tahun" },
            ...tahunOpsi.map((item) => ({ value: String(item), label: String(item) })),
          ]}
        />
      </label>
      <label className="filter-laporan-group">
        <span className="filter-laporan-label">Status periode</span>
        <Select
          aria-label="Status periode"
          value={status ?? SEMUA_STATUS}
          onChange={(event) => {
            const nilai = event.currentTarget.value;
            setQuery("status", nilai === SEMUA_STATUS ? null : nilai);
          }}
          options={[
            { value: SEMUA_STATUS, label: "Semua status" },
            { value: "OPEN", label: "Terbuka" },
            { value: "CLOSING_IN_PROGRESS", label: "Proses closing" },
            { value: "CLOSED", label: "Tertutup" },
          ]}
        />
      </label>
    </div>
  );

  const ringkas = `${tahun === null ? "Semua tahun" : tahun}, ${
    status === null ? "semua status" : (LABEL_STATUS_PERIODE[status] ?? status)
  }`;

  return (
    <HalamanModul route={route}>
      {kecil ? <Penyaring ringkas={ringkas}>{kontrol}</Penyaring> : kontrol}

      <Muat hasil={referensi} judul="referensi closing" sumber="GET /api/closing/referensi">
        {(ref: ReferensiClosing) => (
          <>
            {/*
             * TWO COLUMNS THAT FLOW INDEPENDENTLY, NOT FOUR CELLS IN TWO ROWS.
             * The register grows one row per month while the policy card is a
             * fixed eight lines, so pairing them in one grid row stretched
             * whichever was shorter and left a void inside its border. Stacked
             * this way each card keeps its own height: the register and the
             * trace of the selected month on the left, the policies in force and
             * the reopen on the right.
             */}
            <Bento columns={3}>
              <BentoItem span="wide">
                <div className="closing-kolom">
                  <PanelSumber
                    title="Daftar periode akuntansi"
                    description="Urut dari bulan terbaru. Satu baris adalah satu bulan buku beserta jejak siapa menutupnya dan siapa membukanya kembali."
                    sumber="GET /api/closing/periode"
                  >
                    <Muat hasil={daftar} judul="daftar periode" sumber="GET /api/closing/periode">
                      {(isi) => (
                        <DaftarPeriode
                          rows={isi.data}
                          onPilih={(row) => setQuery("periode", row.id)}
                        />
                      )}
                    </Muat>
                  </PanelSumber>

                  {periode === null ? null : (
                    <PanelSumber
                      title={`Jejak periode ${formatPeriode(periode.tahun, periode.bulan)}`}
                      description="Siapa menutup, kapan, dan bila pernah dibuka kembali, dengan alasan tertulisnya."
                      sumber="GET /api/closing/periode"
                      aside={<StatusBadge status={periode.status} />}
                    >
                      <FaktaPeriode periode={periode} />
                    </PanelSumber>
                  )}
                </div>
              </BentoItem>

              <BentoItem span="sm">
                <div className="closing-kolom">
                  <PanelSumber
                    title="Lingkup dan kebijakan"
                    description="Cabang yang boleh Anda tutup, dan parameter akuntansi yang sedang berlaku."
                    sumber="GET /api/closing/referensi"
                  >
                    <DataList
                      items={[
                        {
                          label: "Cabang dalam wewenang",
                          value:
                            ref.cabang.length === 0
                              ? "Tidak ada cabang"
                              : ref.cabang.map((c) => `${c.kode} ${c.nama}`).join(", "),
                          wide: true,
                        },
                        {
                          label: "Cakupan seluruh entitas",
                          value: ref.bolehSemuaCabang
                            ? "Ya, closing boleh dijalankan untuk semua cabang sekaligus"
                            : "Tidak, closing hanya untuk cabang di atas",
                          wide: true,
                        },
                      ]}
                    />
                    <KartuKebijakan kapabilitas={ref.kapabilitas} />
                  </PanelSumber>

                  {periode === null ? null : (
                    <PanelSumber
                      title="Buka kembali periode"
                      description="Tindakan Admin Pusat. Mengembalikan periode tertutup menjadi terbuka dan menghapus saldo bekunya."
                      sumber="POST /api/closing/periode/:id/buka"
                    >
                      <PanelReopen
                        periode={periode}
                        izinkanReopen={ref.kapabilitas.izinkanReopen}
                        bolehReopen={bolehReopen}
                        onSelesai={() => {
                          daftar.reload();
                        }}
                      />
                    </PanelSumber>
                  )}
                </div>
              </BentoItem>
            </Bento>

            {periode === null ? null : (
              <SaldoBeku key={periode.id} periode={periode} referensi={ref} />
            )}
          </>
        )}
      </Muat>

      <p className="page-note">
        <Icon name="info" size={16} />
        <span>
          Saldo akun periode tertutup dibaca apa adanya dari hasil pembekuan saat closing, bukan
          dihitung ulang, jadi cetak ulang laporan bulan itu menghasilkan angka yang sama persis.
        </span>
      </p>
      <CatatanOtorisasi tambahan="Membaca periode, menutup periode, dan membuka kembali periode adalah tiga kewenangan terpisah." />
    </HalamanModul>
  );
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

function DaftarPeriode({
  rows,
  onPilih,
}: {
  rows: readonly OpsiPeriodeClosing[];
  onPilih: (row: OpsiPeriodeClosing) => void;
}) {
  const columns: readonly ColumnSpec<OpsiPeriodeClosing>[] = [
    {
      // The month alone. The date range used to sit under it as a second line
      // and it truncated at every desktop width, which is a figure nobody can
      // read; the full range is stated in the Jejak panel below, where there is
      // room for it.
      key: "periode",
      header: "Periode",
      width: "120px",
      render: (row) => (
        <span className="sel-utama">
          <span className="sel-utama-judul">{formatPeriode(row.tahun, row.bulan)}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "110px",
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "closedOleh",
      header: "Ditutup oleh",
      render: (row) =>
        row.closedOleh ? (
          <span className="sel-ringkas">{row.closedOleh}</span>
        ) : (
          <span className="angka-kosong">Belum ditutup</span>
        ),
    },
    {
      key: "closedAt",
      header: "Waktu tutup",
      width: "120px",
      render: (row) =>
        row.closedAt ? formatDate(row.closedAt) : <span className="angka-kosong">Belum</span>,
    },
    {
      key: "dibukaKembaliOleh",
      header: "Dibuka kembali",
      width: "140px",
      render: (row) =>
        row.dibukaKembaliOleh ? (
          <span className="sel-ringkas">{row.dibukaKembaliOleh}</span>
        ) : (
          <span className="angka-kosong">Tidak pernah</span>
        ),
    },
    {
      key: "jumlahSaldoBeku",
      header: "Saldo beku",
      type: "count",
      width: "100px",
      render: (row) => <span className="angka">{formatCount(row.jumlahSaldoBeku)}</span>,
    },
  ];

  return (
    <DaftarDokumen
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      onPilih={onPilih}
      emptyTitle="Belum ada periode akuntansi"
      emptyDescription="Belum ada satu periode pun untuk filter ini. Periode dibentuk pada konfigurasi tahun buku, dan closing hanya bisa dijalankan atas periode yang sudah ada."
      kartu={(row) => ({
        judul: formatPeriode(row.tahun, row.bulan),
        sub: row.closedOleh ? `Ditutup oleh ${row.closedOleh}` : "Belum ditutup",
        nilai: formatCount(row.jumlahSaldoBeku),
        nilaiLabel: "Saldo beku",
        meta: row.closedAt ? formatDate(row.closedAt) : "Tanpa tanggal tutup",
        status: <StatusBadge status={row.status} />,
      })}
    />
  );
}

function FaktaPeriode({ periode }: { periode: OpsiPeriodeClosing }) {
  const items = useFaktaPeriode(periode);
  return <DataList items={items} columns={2} />;
}

// ---------------------------------------------------------------------------
// Reopen
// ---------------------------------------------------------------------------

function PanelReopen({
  periode,
  izinkanReopen,
  bolehReopen,
  onSelesai,
}: {
  periode: OpsiPeriodeClosing;
  izinkanReopen: boolean;
  bolehReopen: boolean;
  onSelesai: () => void;
}) {
  const [alasan, setAlasan] = useState("");
  const [terbuka, setTerbuka] = useState(false);
  const aksi = useAction((input: { periodeId: string; alasan: string }) =>
    bukaKembaliPeriode(input.periodeId, { alasan: input.alasan }),
  );

  if (!bolehReopen) {
    return (
      <TanpaWewenang judul="Reopen adalah tindakan Admin Pusat">
        Membuka kembali periode memerlukan kewenangan admin.periode.reopen, yang menurut aturan
        pemisahan tugas hanya dipegang Admin Pusat, bahkan tidak oleh Approver yang berhak menutup
        periode. Halaman ini tetap bisa dibaca sebagai bukti, tanpa tombol yang mengubah apa pun.
      </TanpaWewenang>
    );
  }

  if (!izinkanReopen) {
    return (
      <TanpaWewenang judul="Reopen dimatikan pada konfigurasi">
        Parameter akuntansi izinkan_reopen_periode sedang bernilai tidak, jadi server akan menolak
        permintaan reopen apa pun. Ubah dulu parameter itu di Konfigurasi Parameter Sistem bila
        kebijakan memang berubah.
      </TanpaWewenang>
    );
  }

  if (periode.status !== "CLOSED") {
    return (
      <TanpaWewenang judul="Periode ini belum tertutup">
        Hanya periode berstatus tertutup yang bisa dibuka kembali, dan hanya periode tertutup yang
        paling akhir. Periode {formatPeriode(periode.tahun, periode.bulan)} sedang berstatus{" "}
        {LABEL_STATUS_PERIODE[periode.status] ?? periode.status}.
      </TanpaWewenang>
    );
  }

  const bersih = alasan.trim();
  const alasanSiap = bersih.length >= MIN_ALASAN_REOPEN && bersih.length <= MAX_ALASAN_REOPEN;

  return (
    <>
      <Field
        label="Alasan reopen"
        htmlFor="reopen-alasan"
        hint={`Wajib diisi, ${MIN_ALASAN_REOPEN} sampai ${MAX_ALASAN_REOPEN} karakter. Alasan ini tersimpan pada periode dan pada audit log, dan dibaca auditor berbulan bulan kemudian.`}
      >
        <Textarea
          id="reopen-alasan"
          rows={4}
          value={alasan}
          maxLength={MAX_ALASAN_REOPEN}
          onChange={(event) => setAlasan(event.currentTarget.value)}
        />
      </Field>

      <div className="closing-aksi">
        {aksi.status === "gagal" ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{aksi.error}</span>
          </p>
        ) : null}
        <div className="closing-aksi-row">
          <Button
            variant="danger"
            disabled={!alasanSiap}
            onClick={() => setTerbuka(true)}
            leading={<Icon name="history" size={16} />}
          >
            Buka kembali periode
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={terbuka}
        tone="danger"
        title={`Buka kembali periode ${formatPeriode(periode.tahun, periode.bulan)}`}
        description="Baca dulu apa yang akan terjadi. Tindakan ini mengubah bulan yang sudah pernah dilaporkan."
        confirmLabel="Ya, buka kembali periode"
        confirmPhrase={FRASA_REOPEN}
        confirmPhraseLabel="Ketik untuk mengonfirmasi reopen"
        loading={aksi.status === "mengirim"}
        error={aksi.error}
        onCancel={() => setTerbuka(false)}
        onConfirm={async () => {
          const hasil = await aksi.jalankan({ periodeId: periode.id, alasan: bersih });
          if (hasil) {
            setTerbuka(false);
            setAlasan("");
            onSelesai();
          }
        }}
      >
        <DataList
          items={[
            { label: "Periode", value: formatPeriode(periode.tahun, periode.bulan) },
            { label: "Status sekarang", value: "Tertutup" },
            { label: "Status setelah tindakan", value: "Terbuka kembali" },
            {
              label: "Saldo beku yang dihapus",
              value: `${formatCount(periode.jumlahSaldoBeku)} baris`,
              numeric: true,
            },
            {
              label: "Cap template laporan",
              value: "Dihapus, laporan bulan ini kembali memakai template berlaku menurut tanggal",
              wide: true,
            },
            { label: "Alasan tercatat", value: bersih, wide: true },
          ]}
        />
        <p className="konfirmasi-catatan">
          Server hanya menerima reopen atas periode tertutup yang paling akhir, dan tetap menolak
          bila parameter akuntansi melarangnya. Nama Anda, waktu, dan alasan di atas tercatat pada
          audit log.
        </p>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// The frozen balances
// ---------------------------------------------------------------------------

function SaldoBeku({
  periode,
  referensi,
}: {
  periode: OpsiPeriodeClosing;
  referensi: ReferensiClosing;
}) {
  const tertutup = periode.status === "CLOSED";
  const hasil = useApi(() => saldoPeriodeClosing(periode.id), [periode.id], {
    enabled: tertutup,
  });

  const namaCabang = (id: string): string => {
    const cabang = referensi.cabang.find((c) => c.id === id);
    return cabang ? `${cabang.kode} ${cabang.nama}` : id;
  };

  const columns: readonly Column<SaldoAkunPeriode>[] = [
    { key: "akunKode", header: "Kode akun", width: "130px" },
    {
      key: "cabangId",
      header: "Cabang",
      render: (row) => <span className="sel-ringkas">{namaCabang(row.cabangId)}</span>,
    },
    {
      key: "saldoAwal",
      header: "Saldo awal",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.saldoAwal} />,
    },
    {
      key: "mutasiDebit",
      header: "Mutasi debit",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.mutasiDebit} />,
    },
    {
      key: "mutasiKredit",
      header: "Mutasi kredit",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.mutasiKredit} />,
    },
    {
      key: "saldoAkhir",
      header: "Saldo akhir",
      type: "money",
      width: "150px",
      render: (row) => <NilaiUang nilai={row.saldoAkhir} />,
    },
  ];

  return (
    <PanelSumber
      title={`Saldo akun beku periode ${formatPeriode(periode.tahun, periode.bulan)}`}
      description="Angka yang dibekukan saat closing. Semua nilai memakai konvensi debit positif, jadi akun bersaldo normal kredit tampil negatif di sini."
      sumber="GET /api/closing/periode/:id/saldo"
    >
      {!tertutup ? (
        <AntreanKosong
          icon="calendar"
          title="Periode ini belum ditutup"
          description="Saldo akun baru dibekukan pada saat closing dijalankan. Selama periode masih terbuka, laporan bulan ini dihitung langsung dari ledger dan masih bisa berubah."
        />
      ) : (
        <Muat
          hasil={hasil}
          judul="saldo akun beku"
          sumber="GET /api/closing/periode/:id/saldo"
        >
          {(isi) =>
            isi.data.length === 0 ? (
              <AntreanKosong
                icon="alert"
                title="Periode tertutup tanpa satu baris saldo beku"
                description="Periode ini berstatus tertutup tetapi tidak menyimpan satu baris saldo pun. Laporan periode tertutup membaca saldo beku, jadi kondisi ini akan ditolak saat laporan dicetak dan perlu ditelusuri bersama tim akuntansi."
              />
            ) : (
              <>
                <div className="daftar-tabel">
                  <DataTable
                    columns={columns}
                    rows={isi.data}
                    rowKey={(row) => `${row.cabangId}#${row.akunId}`}
                    emptyTitle="Tidak ada saldo beku"
                    emptyDescription="Tidak ada baris saldo beku pada periode ini."
                  />
                </div>
                <div className="daftar-kartu">
                  <ul className="kartu-list">
                    {isi.data.map((row) => (
                      <li className="kartu-item is-statis" key={`${row.cabangId}#${row.akunId}`}>
                        <div className="closing-kartu">
                          <p className="kartu-judul">{row.akunKode}</p>
                          <p className="kartu-sub">{namaCabang(row.cabangId)}</p>
                          <dl className="closing-angka">
                            {[
                              { label: "Saldo awal", nilai: row.saldoAwal },
                              { label: "Mutasi debit", nilai: row.mutasiDebit },
                              { label: "Mutasi kredit", nilai: row.mutasiKredit },
                              { label: "Saldo akhir", nilai: row.saldoAkhir },
                            ].map((sel) => (
                              <div className="closing-sel" key={sel.label}>
                                <dt>{sel.label}</dt>
                                <dd className="angka">{teksUang(sel.nilai)}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )
          }
        </Muat>
      )}
    </PanelSumber>
  );
}
