// The two configuration entries that HAVE NO API, and are not getting one here.
//
// `/konfigurasi/template-laporan` and `/konfigurasi/nomor-dokumen` are the only
// two entries in spec 9.4 with no endpoint behind them, and that is a decision
// rather than a gap in the schedule. Both are EFFECTIVE-DATED problems, and
// neither has an answer yet:
//
//   A TEMPLATE EDIT APPLIES TO A REPRINT. `baris_laporan` has no valid-from
//   column. Move a line today and a reprint of March comes out with today's
//   layout while the signed March report on file has last month's. Nobody
//   notices, because both add up.
//
//   A NUMBERING FORMAT CHANGED MID YEAR GIVES ONE YEAR TWO SHAPES. Every
//   document number already issued carries the old pattern, and the counter
//   reset rule is part of the pattern, so changing it in August means the
//   filing cabinet holds two different-looking series for the same year with
//   nothing on the page saying which rule produced which.
//
// SO THIS PAGE IS AN HONEST STATEMENT, NOT A PLACEHOLDER AND NOT A FORM.
//
// The alternative was to leave the nav entries pointing at the generic
// Placeholder, which renders "yang akan tersedia di halaman ini" and reads as
// "not built yet, coming soon". That would be the wrong sentence: the work is
// not queued, it is BLOCKED on a decision that only the client can make, and a
// screen that says "soon" invites somebody to wait for it instead of answering
// the question. So the page names the question, names what has to be decided
// before an endpoint can exist, and names the route that still works today.
//
// IT CARRIES NO CONTROL OF ANY KIND. A disabled form here would be worse than
// nothing: it would imply the shape of the answer is already known.
import { Bento, BentoItem, Icon, Panel } from "@krakatausteel/ui";
import type { PageRoute } from "../../nav";
import { CatatanOtorisasi, HalamanModul } from "../shared/parts";

interface Alasan {
  /** The question that has to be answered before an endpoint can exist. */
  pertanyaan: string;
  /** What goes wrong if it ships without an answer, in concrete terms. */
  akibat: readonly string[];
  /** How the value is changed today, since it does change. */
  jalanSekarang: string;
  /** What already reads this configuration, so the reader knows where to look. */
  yangAda: string;
}

const ALASAN: Record<string, Alasan> = {
  "/konfigurasi/template-laporan": {
    pertanyaan:
      "Kalau susunan baris laporan diubah hari ini, apakah cetak ulang laporan bulan Maret memakai susunan yang lama atau yang baru?",
    akibat: [
      "Susunan baris laporan tidak menyimpan tanggal mulai berlaku, jadi satu satunya jawaban yang bisa diberikan sistem sekarang adalah susunan terbaru, untuk periode apa pun.",
      "Akibatnya cetak ulang laporan periode lama bisa berbeda dari laporan yang sudah ditandatangani dan diarsipkan, sementara keduanya sama sama seimbang dan lolos semua validasi.",
      "Perbedaan seperti itu tidak terlihat dari angka mana pun, jadi tidak ada pemeriksaan yang bisa menangkapnya setelah terjadi.",
    ],
    jalanSekarang:
      "Susunan baris laporan diubah lewat migrasi basis data yang ditinjau dan tercatat pada riwayat migrasi, sehingga setiap perubahan punya tanggal, penulis, dan alasan.",
    yangAda:
      "Susunan yang berlaku sekarang bisa dibaca dari laporan yang memakainya: Laporan Posisi Keuangan, Laporan Aktivitas, dan Laporan Arus Kas pada menu Laporan.",
  },
  "/konfigurasi/nomor-dokumen": {
    pertanyaan:
      "Kalau pola penomoran diubah pada bulan Agustus, apa yang berlaku untuk dokumen yang sudah terbit pada Januari sampai Juli tahun yang sama?",
    akibat: [
      "Nomor yang sudah terbit tidak bisa diubah, karena nomor itulah yang tercetak pada dokumen fisik dan disebut pada perjanjian.",
      "Akibatnya satu tahun buku akan berisi dua bentuk nomor sekaligus, dan tidak ada apa pun pada nomor itu yang menyatakan pola mana yang membentuknya.",
      "Aturan reset counter adalah bagian dari pola, jadi mengubahnya di tengah tahun juga bisa membuat dua dokumen berbeda memperoleh nomor urut yang sama.",
    ],
    jalanSekarang:
      "Pola penomoran per jenis dokumen diubah lewat migrasi basis data yang ditinjau, sehingga perubahan pola selalu punya tanggal dan alasan yang tercatat.",
    yangAda:
      "Nomor yang sudah terbentuk bisa dibaca pada dokumennya masing masing: Daftar Jurnal, daftar proposal, dan daftar akad menampilkan nomor lengkapnya.",
  },
};

export function BelumTersedia({ route }: { route: PageRoute }) {
  const alasan = ALASAN[route.path];

  return (
    <HalamanModul route={route}>
      <Panel
        as="h2"
        title="Halaman ini belum tersedia, dan alasannya bukan jadwal"
        description="Belum ada endpoint untuk membaca maupun menulis konfigurasi ini, karena satu pertanyaan belum dijawab."
      >
        <p className="penjelasan">
          {alasan?.pertanyaan ??
            "Konfigurasi ini berlaku surut ke dokumen yang sudah terbit, dan aturan berlakunya belum ditetapkan."}
        </p>
        <p className="page-note">
          <Icon name="info" size={16} />
          <span>
            Membuat formulir di sini tanpa jawaban itu berarti menyediakan tombol yang mengubah arti
            dokumen lama tanpa memberi tahu siapa pun. Karena itu formulirnya tidak dibuat, bukan
            ditunda.
          </span>
        </p>
      </Panel>

      {/* The consequence and the remedy sit SIDE BY SIDE rather than stacked.
          Stacked, three narrow full width panels left most of a 1440 screen
          empty below them, which reads as an unfinished page and undercuts the
          one thing this page is for: sounding deliberate. */}
      <Bento columns={2}>
        <BentoItem span="sm">
          <Panel
            as="h2"
            title="Yang terjadi kalau ini dibuat tanpa jawaban"
            description="Tiga akibat konkret, semuanya tidak terlihat dari angka mana pun."
          >
            <ol className="langkah-list">
              {(alasan?.akibat ?? []).map((baris) => (
                <li key={baris}>{baris}</li>
              ))}
            </ol>
          </Panel>
        </BentoItem>
        <BentoItem span="sm">
          <Panel
            as="h2"
            title="Cara mengubahnya hari ini"
            description="Konfigurasi ini tetap bisa berubah. Yang tidak ada adalah jalur swalayan tanpa peninjauan."
            footer={<span className="panel-foot-note">{alasan?.yangAda ?? ""}</span>}
          >
            <p className="penjelasan">{alasan?.jalanSekarang ?? ""}</p>
          </Panel>
        </BentoItem>
      </Bento>

      <CatatanOtorisasi tambahan="Tidak ada endpoint di balik halaman ini, jadi tidak ada permintaan yang dikirim dan tidak ada yang bisa ditolak server." />
    </HalamanModul>
  );
}
