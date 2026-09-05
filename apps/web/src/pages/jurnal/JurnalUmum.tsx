// Input Jurnal Umum, spec 9.4 and spec 6.5. The free form manual journal, used
// for corrections and reclassifications.
//
// IT SAVES A DRAFT AND NOTHING ELSE. There is no control on this page that
// posts, and the route it calls has no flag that could: spec 6.3's whole
// maker / checker / approver split lives in the fact that filing and posting
// are separate acts by separate people, and a "simpan dan posting" button here
// would be one click away from collapsing it. The result panel says what was
// saved and who has to touch it next, in those words.
//
// THE ENGINE DECIDES WHETHER THE DOCUMENT IS VALID, NOT THIS FORM. Balance, the
// two line minimum, "exactly one of debit and kredit" and whether an account
// may be posted to are stated once, in modules/jurnal, each with its own code.
// The complaint list under the lines is only what the FORM itself can see: an
// amount it could not read, a line with no account, a difference between the
// two columns. Every one of those is checked again on the server.
import { useState } from "react";
import { Button, Icon, Panel } from "@krakatausteel/ui";
import type { PageRoute } from "../../nav";
import { useActiveSession } from "../../session";
import {
  BarisAksi,
  Bagian,
  CatatanOtorisasi,
  CatatanPencatatan,
  HalamanModul,
  hariIni,
  Muat,
} from "../shared/parts";
import {
  BagianDokumen,
  barisAwal,
  CatatanAlurJurnal,
  EditorBaris,
  hitungTotal,
  HasilDraft,
  keInputBaris,
  keluhanForm,
  KeluhanForm,
  TotalBerjalan,
  useAkun,
  useKirimJurnal,
  type BarisForm,
} from "./parts";

export function JurnalUmum({ route }: { route: PageRoute }) {
  const session = useActiveSession();
  const akun = useAkun();
  const kirim = useKirimJurnal();

  const [cabangId, setCabangId] = useState(session.cabang.id);
  const [tanggal, setTanggal] = useState(hariIni());
  const [keterangan, setKeterangan] = useState("");
  const [baris, setBaris] = useState<BarisForm[]>(barisAwal);

  const total = hitungTotal(baris);
  const keluhan = keluhanForm(baris, total);
  const siap = keluhan.length === 0 && tanggal !== "" && cabangId !== "";

  function ulangi() {
    kirim.reset();
    setBaris(barisAwal());
    setKeterangan("");
  }

  if (kirim.hasil) {
    return (
      <HalamanModul route={route}>
        <HasilDraft jurnal={kirim.hasil} onLagi={ulangi} />
        <CatatanPencatatan />
        <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan jurnal.create." />
      </HalamanModul>
    );
  }

  return (
    <HalamanModul route={route}>
      <CatatanAlurJurnal />

      <BagianDokumen
        cabangId={cabangId}
        setCabangId={setCabangId}
        tanggal={tanggal}
        setTanggal={setTanggal}
        keterangan={keterangan}
        setKeterangan={setKeterangan}
        galat={kirim.galat}
      />

      <Bagian
        title="Baris jurnal"
        description="Setiap baris memakai satu akun dan berdiri di satu sisi saja, debit atau kredit. Hanya akun yang boleh diposting yang muncul di pilihan akun."
        footer={
          <span className="panel-foot-note">
            Daftar akun dibaca dari GET /api/laporan/bagan-akun, dan hanya berisi akun aktif yang
            boleh diposting.
          </span>
        }
      >
        <Muat hasil={akun} judul="bagan akun" sumber="GET /api/laporan/bagan-akun">
          {(data) => (
            <>
              <EditorBaris
                baris={baris}
                onChange={setBaris}
                akun={data.baris}
                galat={kirim.galat}
              />
              <TotalBerjalan total={total} />
            </>
          )}
        </Muat>
      </Bagian>

      <Panel
        as="h2"
        title="Simpan sebagai draft"
        description="Yang tersimpan adalah dokumen DRAFT. Dokumen belum masuk buku besar sampai diposting Approver."
      >
        <KeluhanForm keluhan={keluhan} />
        <BarisAksi
          error={kirim.error}
          primary={
            <Button
              variant="primary"
              disabled={!siap || akun.status !== "siap"}
              loading={kirim.status === "mengirim"}
              leading={<Icon name="check" size={16} />}
              onClick={() =>
                void kirim.kirim({
                  cabangId,
                  jenis: "UMUM",
                  tanggalTransaksi: tanggal,
                  keterangan: keterangan.trim() === "" ? null : keterangan.trim(),
                  baris: keInputBaris(baris),
                })
              }
            >
              Simpan draft jurnal umum
            </Button>
          }
          secondary={
            <Button variant="ghost" onClick={() => setBaris(barisAwal())}>
              Kosongkan baris
            </Button>
          }
        />
      </Panel>

      <CatatanPencatatan />
      <CatatanOtorisasi tambahan="Halaman ini memerlukan kewenangan jurnal.create." />
    </HalamanModul>
  );
}
