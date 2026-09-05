// The pieces the eight configuration screens share, so that "what a
// deactivation does", "which fields are fixed and why", and "how a server
// refusal is rendered" are answered once for the whole group instead of six
// times with six slightly different sentences.
//
// THREE RULES THIS FILE EXISTS TO KEEP, and each of them comes from the shape
// of the API rather than from taste.
//
//   THERE IS NO DELETE ON THIS SURFACE, ANYWHERE, ON PURPOSE. Every row here is
//   referenced by posted history: an account by journal lines, a sector by a
//   proposal, a branch by every document number it ever issued, a user id by
//   every audit row. So the only removal is `aktif = false`, and a screen that
//   offers a deactivation must say what it does AND what it does not do.
//   `PenjelasanTanpaHapus` and `KendaliStatus` are that sentence, written once.
//
//   A REFUSAL IS A SENTENCE, NOT A CODE, AND IT BELONGS ON THE CONTROL THAT
//   CAUSED IT. The API refuses a deactivation with "Akun 1.1.02 adalah kaki
//   dari pemetaan event PENCAIRAN_PUMK ...", not with a status code, and that
//   sentence is worth more than any message this app could write. `Penolakan`
//   renders it in place; nothing here paraphrases it.
//
//   AN IMMUTABLE FIELD IS SHOWN AS FIXED, NOT AS AN INPUT THE SERVER WILL
//   REJECT. A branch code, an account's code, parent, level, type and normal
//   balance are all refused by the router with a reason. `FaktaTetap` renders
//   the value and the reason together, so an operator learns the rule from the
//   page instead of from a failed save.
import { useState, type ReactNode } from "react";
import {
  Bento,
  BentoItem,
  Button,
  ConfirmDialog,
  Icon,
  Panel,
  Stat,
  StatusBadge,
} from "@krakatausteel/ui";

/**
 * The four figure band at the top of every configuration screen. Exactly four
 * cards, one shape, one span, so the row reads as one system on every screen in
 * the group and none of them invents its own header layout.
 */
export interface AngkaPapan {
  label: string;
  nilai: string;
  /** What is being counted, e.g. "Akun". Defaults to "Baris". */
  satuan?: string;
  /** One line under the figure. Always present, so every card is the same height. */
  catatan: string;
}

export function PapanAngka({ items }: { items: readonly AngkaPapan[] }) {
  return (
    <Bento columns={4}>
      {items.map((item) => (
        <BentoItem span="sm" key={item.label}>
          <Panel as="h2" title={item.label} className="panel-kpi" footer={<span>{item.catatan}</span>}>
            <Stat label={item.satuan ?? "Baris"} value={item.nilai} />
          </Panel>
        </BentoItem>
      ))}
    </Bento>
  );
}

/** A server refusal, in the server's own words, on the control that caused it. */
export function Penolakan({ pesan }: { pesan: string | null }) {
  if (!pesan) return null;
  return (
    <p className="form-error" role="alert">
      <Icon name="alert" size={16} />
      <span>{pesan}</span>
    </p>
  );
}

/** The confirmation that an action landed. Never a claim about anything else. */
export function Berhasil({ pesan }: { pesan: string | null }) {
  if (!pesan) return null;
  return (
    <p className="periksa-ok">
      <Icon name="check" size={16} />
      <span>{pesan}</span>
    </p>
  );
}

/**
 * A field the API refuses to change, shown as a fact with its reason.
 *
 * Deliberately NOT a disabled input. A greyed out text box reads as "you are
 * not allowed today", which invites somebody to look for the permission that
 * unlocks it. There is none: the value is the identity that posted history
 * points at, and the remedy is a new row plus a deactivation.
 */
export interface FaktaTetapItem {
  label: string;
  value: ReactNode;
  /** Why it cannot change. One sentence, in the operator's language. */
  alasan: string;
}

export function FaktaTetap({ items }: { items: readonly FaktaTetapItem[] }) {
  return (
    <ul className="tetap-list">
      {items.map((item) => (
        <li className="tetap-item" key={item.label}>
          <span className="tetap-head">
            <span className="tetap-label">{item.label}</span>
            <span className="tetap-kunci">
              <Icon name="lock" size={14} />
              <span>Tetap</span>
            </span>
          </span>
          <span className="tetap-nilai">{item.value}</span>
          <span className="tetap-alasan">{item.alasan}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The panel every configuration screen carries above its list: this surface has
 * no delete, and here is what deactivation does instead.
 *
 * `dipakai` names what already refers to the row, in this entity's own words,
 * because "referential integrity" is not a sentence an accountant can act on
 * and "proposal yang sudah diposting" is.
 */
export function PenjelasanTanpaHapus({
  subjek,
  dipakai,
  tambahan,
}: {
  /** Plural, lower case: "Akun", "Sektor", "Cabang". */
  subjek: string;
  dipakai: string;
  tambahan?: string;
}) {
  return (
    <Panel
      as="h2"
      title={`${subjek} tidak pernah dihapus, hanya dinonaktifkan`}
      description="Berlaku untuk seluruh master pada aplikasi ini, tanpa pengecualian."
      className="panel-panduan"
    >
      <ol className="langkah-list">
        <li>
          Tidak ada tombol hapus di halaman ini, dan tidak ada endpoint hapus di server. {dipakai}{" "}
          masih menunjuk baris ini, jadi menghapusnya berarti mengubah arti dokumen yang sudah
          terbit.
        </li>
        <li>
          Menonaktifkan <strong>menghilangkan baris ini dari setiap pilihan pada formulir baru</strong>.
          Yang sudah terlanjur memakainya tidak berubah sedikit pun: dokumen lama tetap terbaca,
          laporan periode lama tetap menghasilkan angka yang sama.
        </li>
        <li>
          Nonaktif bisa dibatalkan. Mengaktifkan kembali mengembalikan baris ini ke daftar pilihan,
          dan tidak menyentuh satu pun dokumen di antara kedua tanggal itu.
        </li>
        {tambahan ? <li>{tambahan}</li> : null}
      </ol>
    </Panel>
  );
}

/**
 * The activate and deactivate control, with the consequences stated before the
 * click and the server's refusal rendered after it.
 *
 * `tertahan` is the refusal the screen ALREADY KNOWS, from a fact the list
 * endpoint answered (`punyaAnak`, `dipakaiMapping`, `dipakaiJurnal`). When it
 * is set the control is disabled and the reason is printed, so an operator is
 * not offered an action the server is certain to refuse. The server refuses it
 * again regardless: this is a courtesy, never the control.
 */
export function KendaliStatus({
  aktif,
  subjek,
  akibat,
  bukanAkibat,
  tertahan,
  mengirim,
  error,
  terkunci,
  alasanTerkunci,
  onUbah,
}: {
  aktif: boolean;
  /** What is being switched, spelled out: "Akun 1.1.01 Kas di Bank". */
  subjek: string;
  akibat: readonly string[];
  bukanAkibat: readonly string[];
  tertahan: string | null;
  mengirim: boolean;
  error: string | null;
  /** Set while something else on the page must not be interrupted. */
  terkunci?: boolean;
  alasanTerkunci?: string;
  onUbah: (aktif: boolean) => void;
}) {
  const [konfirmasi, setKonfirmasi] = useState(false);
  const tujuan = !aktif;
  const blokir = tujuan === false && tertahan !== null;

  return (
    <>
      <div className="status-kendali">
        <div className="status-teks">
          <p className="status-judul">
            Status saat ini <StatusBadge status={aktif ? "AKTIF" : "NONAKTIF"} tone={aktif ? "success" : "neutral"} label={aktif ? "Aktif" : "Nonaktif"} />
          </p>
          <p className="status-sub">
            {aktif
              ? "Baris ini muncul pada pilihan di formulir baru."
              : "Baris ini sudah tidak muncul pada pilihan di formulir baru. Dokumen lama tetap utuh."}
          </p>
        </div>
        <Button
          variant={aktif ? "ghost" : "primary"}
          leading={<Icon name={aktif ? "lock" : "check"} size={16} />}
          disabled={blokir || terkunci === true}
          loading={mengirim}
          onClick={() => setKonfirmasi(true)}
        >
          {aktif ? "Nonaktifkan" : "Aktifkan kembali"}
        </Button>
      </div>
      {blokir ? <Penolakan pesan={tertahan} /> : null}
      {terkunci && alasanTerkunci ? (
        <p className="periksa-item">
          <Icon name="alert" size={16} />
          <span>{alasanTerkunci}</span>
        </p>
      ) : null}
      <Penolakan pesan={error} />

      <ConfirmDialog
        open={konfirmasi}
        title={tujuan ? `Aktifkan kembali ${subjek}` : `Nonaktifkan ${subjek}`}
        description={
          tujuan
            ? "Baris ini akan muncul lagi pada pilihan di formulir baru. Dokumen yang sudah terbit tidak tersentuh."
            : "Baris ini akan hilang dari pilihan di formulir baru. Dokumen yang sudah terbit tidak tersentuh."
        }
        confirmLabel={tujuan ? "Aktifkan kembali" : "Nonaktifkan"}
        tone={tujuan ? "primary" : "danger"}
        loading={mengirim}
        error={error}
        onCancel={() => setKonfirmasi(false)}
        onConfirm={() => {
          setKonfirmasi(false);
          onUbah(tujuan);
        }}
      >
        <div className="akibat-grid">
          <div className="akibat-kolom">
            <p className="akibat-judul">Yang berubah</p>
            <ul className="akibat-list">
              {akibat.map((baris) => (
                <li key={baris}>{baris}</li>
              ))}
            </ul>
          </div>
          <div className="akibat-kolom">
            <p className="akibat-judul">Yang tidak berubah</p>
            <ul className="akibat-list">
              {bukanAkibat.map((baris) => (
                <li key={baris}>{baris}</li>
              ))}
            </ul>
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

/**
 * A boolean property of a master row: one checkbox, its visible label, one line
 * of what it means, and the reason it is unavailable when it is.
 *
 * The reason is rendered even when the box is disabled, because the interesting
 * case here is exactly that: "akun ini sudah punya baris jurnal" is the fact an
 * accountant needs, and a checkbox that is simply greyed out states nothing.
 */
export function SaklarSifat({
  id,
  label,
  arti,
  checked,
  tertahan,
  onChange,
}: {
  id: string;
  label: string;
  arti: string;
  checked: boolean;
  /** Non null disables the box and is printed under it. */
  tertahan?: string | null;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={tertahan ? "sifat-item is-tertahan" : "sifat-item"}>
      <label className="sifat-kotak" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={tertahan != null}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="sifat-teks">
          <span className="sifat-label">{label}</span>
          <span className="sifat-arti">{arti}</span>
        </span>
      </label>
      {tertahan ? <p className="sifat-alasan">{tertahan}</p> : null}
    </div>
  );
}

/**
 * The note a screen carries when the signed in role can READ the master but
 * cannot write it. Stated rather than left to be inferred from missing buttons:
 * a control that is simply absent cannot tell anyone which permission it needed.
 */
export function TanpaWewenang({ izin, tindakan }: { izin: string; tindakan: string }) {
  return (
    <p className="periksa-item">
      <Icon name="lock" size={16} />
      <span>
        Peran Anda dapat membaca daftar ini, tetapi tidak memegang kewenangan {izin} yang dibutuhkan
        untuk {tindakan}. Kontrolnya tidak ditampilkan, dan server tetap menolaknya bila dipanggil
        langsung.
      </span>
    </p>
  );
}
