// Read models for the Non PUMK HTTP surface (spec 9.2): the reference lists
// the proposal form picks from, the policy bounds it validates against, and
// the LABELS the list, detail and monitoring screens need next to the ids.
//
// WHY THIS FILE EXISTS SEPARATELY FROM ./service.ts
// `NonPumkEngine` is the WRITE side plus the reads that are BEHAVIOUR: the
// staged-disbursement headroom, the ledger effect of a grant, the ageing of a
// late LPJ. Those are decisions, they are pinned by 138 tests, and none of
// them belongs here. What a screen additionally needs is a PROJECTION: spec
// 9.2 asks for a proposal list filterable by bidang and by SDG, which means
// nothing to an operator unless the row carries the bidang's NAME and the
// SDG's number and name rather than two uuids. That is a join, not a rule, so
// it lives here and the engine keeps its shape.
//
// THE FOUR RULES THIS FILE OBEYS
//
// 1. IT NEVER DECIDES SCOPE OF ITS OWN, IT DELEGATES. Every list and every
//    by-id read goes through the ENGINE first (`PorterMesinNonPumk`), so the
//    branch rule of spec 2 rule 3 is applied exactly once, in the service, and
//    against the branch the ROW reports. This file then decorates rows the
//    engine already agreed to return. A second copy of the scope predicate
//    here is precisely how spec 16 scenario 24 comes back: two filters that
//    agree today and drift in the next phase.
//
// 2. NO POLICY NUMBER OF ITS OWN. `batasan` reads the four `konfigurasi` rows
//    migration 0022 ships, through the SAME repo query the engine reads them
//    with, so the form's bounds and the engine's refusals cannot disagree. An
//    absent row is `KONFIGURASI_TIDAK_ADA`, never a literal.
//
// 3. NO ARITHMETIC OF ITS OWN. `totalDisalurkan` on a list row is a SUM of the
//    live termin, the same sum the engine's guard reads; the ageing buckets,
//    the headroom and the ledger figures come from the engine untouched.
//
// 4. IT WRITES NOTHING. Every function here is a SELECT.
import type {
  BarisMonitoringLpj,
  FilterMonitoringLpj,
  FilterProposalNonPumk,
  NonPumkContext,
  NonPumkDbPort,
  NonPumkTx,
  ProposalNonPumk,
  RingkasanProposal,
  StatusLpj,
  Uang,
} from "./contract";
import { tolakKonfigurasi } from "./kesalahan";
import { createNonPumkRepo } from "./repo";
import { bacaUang, dariSen, keMikro } from "./uang";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The Non PUMK engine, as the SUBSET the read side uses. Structurally
 * satisfied by `NonPumkEngine`, so the composition root passes the SAME
 * instance the write path drives.
 *
 * A port rather than a direct dependency for the reason rule 1 above gives:
 * this file must be unable to answer a row the engine would have refused, and
 * the only way to guarantee that is to have no query of its own that can
 * select one.
 */
export interface PorterMesinNonPumk {
  daftarProposal(
    filter: FilterProposalNonPumk,
    ctx: NonPumkContext,
  ): Promise<ProposalNonPumk[]>;
  ringkasan(proposalId: string, ctx: NonPumkContext): Promise<RingkasanProposal>;
  monitoringLpj(
    filter: FilterMonitoringLpj,
    ctx: NonPumkContext,
  ): Promise<BarisMonitoringLpj[]>;
}

export interface NonPumkBacaDeps {
  db: NonPumkDbPort;
  mesin: PorterMesinNonPumk;
}

// ---------------------------------------------------------------------------
// View shapes
// ---------------------------------------------------------------------------

/**
 * Spec 9.2's bounds, as the proposal form needs them BEFORE it lets anything
 * be typed. Every figure is a `konfigurasi` row (migration 0022); the three
 * ageing thresholds are the SPEC's and are therefore a constant, which is why
 * they are reported separately from the configurable deadline.
 */
export interface BatasanNonPumk {
  nilaiMin: Uang;
  nilaiMax: Uang;
  /** The pass mark a penilaian must reach before a REKOMENDASI is allowed. */
  skorPenilaianMinimumLolos: string;
  /** Days after the last termin by which the LPJ is due. Configurable. */
  batasHariLpj: number;
  /** 30/60/90. The spec's own buckets, not configurable. */
  ambangUmurLpj: readonly number[];
}

export interface OpsiReferensi {
  id: string;
  kode: string;
  nama: string;
}

export interface OpsiSdg {
  id: string;
  nomor: number;
  nama: string;
}

export interface LabelBidang {
  bidangKode: string;
  bidangNama: string;
  cabangNama: string;
}

/** One row of the proposal list of spec 9.2, with every id resolved to a label. */
export interface BarisProposalNonPumk extends ProposalNonPumk, LabelBidang {
  /** The weighted SDG mapping, ordered by goal number. */
  sdg: Array<{ sdgId: string; nomor: number; nama: string; bobot: string }>;
  /** SUM of the live termin. "0.00" before the first disbursement. */
  totalDisalurkan: Uang;
  /** The LPJ's own status, or null when none has been filed. */
  statusLpj: StatusLpj | null;
  /**
   * Whole days from `tanggalProposal` to today: how long this proposal has been
   * in the queue the operator is looking at.
   *
   * NOT the LPJ ageing. That one is `BarisMonitoringLpj.umurHari`, it runs from
   * the LAST DISBURSEMENT, it is the engine's, and it carries the 30/60/90
   * bucket with it. Two ages that are both "umurHari" is a trap, so it is
   * spelled out here: this field says how long a decision has been pending, and
   * that one says how overdue an accountability report is.
   *
   * Measured against the DATABASE's `current_date`, not against the engine's
   * injectable clock, because it is a queue-freshness indicator rather than a
   * figure any rule is applied to. Nothing refuses anything because of it.
   */
  umurHari: number;
}

/** The detail page: everything the engine computes, plus the labels. */
export interface DetailProposalNonPumk extends RingkasanProposal, LabelBidang {}

/** A monitoring row with the two labels the dashboard prints. */
export interface BarisMonitoringLpjBerlabel extends BarisMonitoringLpj, LabelBidang {}

export interface NonPumkBaca {
  batasan(ctx: NonPumkContext): Promise<BatasanNonPumk>;
  daftarBidang(ctx: NonPumkContext): Promise<OpsiReferensi[]>;
  daftarSdg(ctx: NonPumkContext): Promise<OpsiSdg[]>;
  /**
   * Postable, active BEBAN accounts of this entity. The disbursement form has
   * to pick one because spec 6.4's PENYALURAN_NON_PUMK mapping carries
   * `debit_dari_payload = true`; this list is what makes that a dropdown
   * instead of a uuid typed by hand.
   */
  daftarAkunBeban(ctx: NonPumkContext): Promise<OpsiReferensi[]>;
  daftarProposal(
    filter: FilterProposalNonPumk,
    ctx: NonPumkContext,
  ): Promise<BarisProposalNonPumk[]>;
  detailProposal(proposalId: string, ctx: NonPumkContext): Promise<DetailProposalNonPumk>;
  monitoringLpj(
    filter: FilterMonitoringLpj,
    ctx: NonPumkContext,
  ): Promise<BarisMonitoringLpjBerlabel[]>;
}

// ---------------------------------------------------------------------------
// Configuration keys. The SAME group and keys ./service.ts reads, so the form
// and the engine cannot bound the same field differently.
// ---------------------------------------------------------------------------

const KONFIG = {
  GRUP: "batasan",
  SKOR_MINIMUM: "skor_penilaian_minimum_lolos_non_pumk",
  NILAI_MIN: "nilai_min_non_pumk",
  NILAI_MAX: "nilai_max_non_pumk",
  BATAS_HARI_LPJ: "batas_hari_lpj_non_pumk",
} as const;

/** Spec 9.2's ageing thresholds. Mirrors AMBANG_UMUR_LPJ in ./contract.ts. */
const AMBANG: readonly number[] = [30, 60, 90];

// ---------------------------------------------------------------------------
// Label rows
// ---------------------------------------------------------------------------

interface LabelBaris {
  id: string;
  cabang_nama: string;
  bidang_kode: string;
  bidang_nama: string;
  total_disalurkan: string;
  status_lpj: string | null;
  sdg_json: string;
  umur_hari: string;
}

const LABEL_KOSONG: LabelBidang = { bidangKode: "", bidangNama: "", cabangNama: "" };

function bacaSdgJson(
  mentah: string,
): Array<{ sdgId: string; nomor: number; nama: string; bobot: string }> {
  try {
    const parsed = JSON.parse(mentah) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Array<{ sdgId: string; nomor: number; nama: string; bobot: string }>;
  } catch {
    return [];
  }
}

export function buatNonPumkBaca({ db, mesin }: NonPumkBacaDeps): NonPumkBaca {
  const repo = createNonPumkRepo();

  async function konfig(tx: NonPumkTx, bumnId: string, kunci: string): Promise<string> {
    const nilai = await repo.konfigurasi(tx, bumnId, KONFIG.GRUP, kunci);
    if (nilai === null || nilai.trim() === "") {
      // FAIL CLOSED, exactly as the engine does. A form that opened with a
      // silent default would let an operator type an amount the engine then
      // refuses, and the refusal would look like a bug in the engine.
      throw tolakKonfigurasi("KONFIGURASI_TIDAK_ADA", KONFIG.GRUP, kunci);
    }
    return nilai.trim();
  }

  /**
   * The labels for a set of proposals, in ONE query.
   *
   * Called only with ids the ENGINE has already returned, so there is no scope
   * predicate here and there must not be one: adding a second one would create
   * two answers to the same question. An id that is not in scope never reaches
   * this function.
   */
  async function label(ids: readonly string[]): Promise<Map<string, LabelBaris>> {
    const peta = new Map<string, LabelBaris>();
    if (ids.length === 0) return peta;
    // Expanded placeholders rather than `= ANY($1::uuid[])`: the driver in
    // core/adapters/db.ts fails that form with 22P02, which is why
    // ./repo.ts expands its lists the same way.
    const daftar = ids.map((_, i) => `$${i + 1}::uuid`).join(", ");
    const baris = await db.query<LabelBaris>(
      `select p.id::text                                as id,
              c.nama                                    as cabang_nama,
              b.kode                                    as bidang_kode,
              b.nama                                    as bidang_nama,
              coalesce(sum(sal.jumlah), 0)::text        as total_disalurkan,
              max(l.status)                             as status_lpj,
              (current_date - p.tanggal_proposal)::text  as umur_hari,
              coalesce(
                (select json_agg(
                          json_build_object(
                            'sdgId', g.id::text,
                            'nomor', g.nomor,
                            'nama',  g.nama,
                            'bobot', ps.bobot::text)
                          order by g.nomor)
                   from nonpumk_proposal_sdg ps
                   join sdg g on g.id = ps.sdg_id
                  where ps.proposal_id = p.id),
                '[]'::json)::text                       as sdg_json
         from nonpumk_proposal p
         join cabang c            on c.id = p.cabang_id
         join bidang_non_pumk b   on b.id = p.bidang_id
         left join nonpumk_penyaluran sal
                on sal.proposal_id = p.id and sal.deleted_at is null
         left join nonpumk_lpj l
                on l.proposal_id = p.id and l.deleted_at is null
        where p.id in (${daftar})
        group by p.id, c.nama, b.kode, b.nama`,
      [...ids],
    );
    for (const b of baris) peta.set(b.id, b);
    return peta;
  }

  return {
    async batasan(ctx): Promise<BatasanNonPumk> {
      const [min, max, skor, hari] = await Promise.all([
        konfig(db, ctx.bumnId, KONFIG.NILAI_MIN),
        konfig(db, ctx.bumnId, KONFIG.NILAI_MAX),
        konfig(db, ctx.bumnId, KONFIG.SKOR_MINIMUM),
        konfig(db, ctx.bumnId, KONFIG.BATAS_HARI_LPJ),
      ]);

      // Every cell is PARSED, and an unparseable one STOPS the call. A form
      // that renders `NaN` as a maximum accepts everything, which is the one
      // failure mode a bounds check must not have.
      const minSen = bacaUang(min);
      const maxSen = bacaUang(max);
      if (minSen.bentuk === "rusak") {
        throw tolakKonfigurasi("KONFIGURASI_TIDAK_VALID", KONFIG.GRUP, KONFIG.NILAI_MIN, min);
      }
      if (maxSen.bentuk === "rusak") {
        throw tolakKonfigurasi("KONFIGURASI_TIDAK_VALID", KONFIG.GRUP, KONFIG.NILAI_MAX, max);
      }
      if (keMikro(skor) === null) {
        throw tolakKonfigurasi(
          "KONFIGURASI_TIDAK_VALID",
          KONFIG.GRUP,
          KONFIG.SKOR_MINIMUM,
          skor,
        );
      }
      if (!/^\d+$/.test(hari)) {
        throw tolakKonfigurasi(
          "KONFIGURASI_TIDAK_VALID",
          KONFIG.GRUP,
          KONFIG.BATAS_HARI_LPJ,
          hari,
        );
      }

      return {
        nilaiMin: dariSen(minSen.sen),
        nilaiMax: dariSen(maxSen.sen),
        skorPenilaianMinimumLolos: skor,
        batasHariLpj: Number(hari),
        ambangUmurLpj: AMBANG,
      };
    },

    async daftarBidang(ctx): Promise<OpsiReferensi[]> {
      // PER BUMN, which the foreign key on nonpumk_proposal is not: the unique
      // index is on (bumn_id, kode), so an id from another entity would be
      // accepted by Postgres. ./repo.ts's `bidangAda` scopes the write the
      // same way; this list must not offer what that check would refuse.
      return db.query<OpsiReferensi>(
        `select id::text as id, kode, nama
           from bidang_non_pumk
          where bumn_id = $1::uuid and aktif and deleted_at is null
          order by urutan, kode`,
        [ctx.bumnId],
      );
    },

    async daftarSdg(): Promise<OpsiSdg[]> {
      // GLOBAL by design: the seventeen goals are the UN's and `sdg_nomor_uq`
      // carries no bumn column (seed/master-program.ts says so).
      const baris = await db.query<{ id: string; nomor: string; nama: string }>(
        // ORDER BY sdg.nomor, QUALIFIED, and that is not style. Postgres
        // resolves a bare `ORDER BY nomor` against the OUTPUT column first, and
        // the output column here is `nomor::text`: the goals would come back
        // 1, 10, 11 ... 17, 2, 3 in a dropdown a user reads top to bottom.
        `select id::text as id, nomor::text as nomor, nama
           from sdg
          where aktif and deleted_at is null
          order by sdg.nomor`,
      );
      return baris.map((b) => ({ id: b.id, nomor: Number(b.nomor), nama: b.nama }));
    },

    async daftarAkunBeban(ctx): Promise<OpsiReferensi[]> {
      // Exactly the predicate ./service.ts's `wajibAkunBeban` enforces, so a
      // pick from this dropdown is never refused at posting time and an
      // account this list omits is one the engine would have refused anyway.
      return db.query<OpsiReferensi>(
        `select id::text as id, kode, nama
           from akun
          where bumn_id = $1::uuid
            and tipe = 'BEBAN'
            and is_postable
            and not is_kas
            and aktif
            and deleted_at is null
          order by kode`,
        [ctx.bumnId],
      );
    },

    async daftarProposal(filter, ctx): Promise<BarisProposalNonPumk[]> {
      // THE ENGINE FILTERS AND SCOPES. This file only decorates.
      const baris = await mesin.daftarProposal(filter, ctx);
      const peta = await label(baris.map((b) => b.id));
      return baris.map((b) => {
        const l = peta.get(b.id);
        const total = l ? bacaUang(l.total_disalurkan) : ({ bentuk: "rusak" } as const);
        return {
          ...b,
          cabangNama: l?.cabang_nama ?? "",
          bidangKode: l?.bidang_kode ?? "",
          bidangNama: l?.bidang_nama ?? "",
          sdg: l ? bacaSdgJson(l.sdg_json) : [],
          totalDisalurkan: dariSen(total.bentuk === "ok" ? total.sen : 0n),
          statusLpj: (l?.status_lpj as StatusLpj | null) ?? null,
          umurHari: Number.parseInt(l?.umur_hari ?? "0", 10) || 0,
        };
      });
    },

    async detailProposal(proposalId, ctx): Promise<DetailProposalNonPumk> {
      // The engine answers FIRST, which is what applies the branch rule: a
      // proposal in another branch throws CABANG_DILUAR_SCOPE here and the
      // label query below is never reached, so a manipulated id in the URL
      // cannot even confirm that the row exists.
      const ringkasan = await mesin.ringkasan(proposalId, ctx);
      const l = (await label([ringkasan.proposal.id])).get(ringkasan.proposal.id);
      return {
        ...ringkasan,
        ...(l
          ? {
              cabangNama: l.cabang_nama,
              bidangKode: l.bidang_kode,
              bidangNama: l.bidang_nama,
            }
          : LABEL_KOSONG),
      };
    },

    async monitoringLpj(filter, ctx): Promise<BarisMonitoringLpjBerlabel[]> {
      // The ageing, the buckets and the `terlambat` flag are the ENGINE's; the
      // order it returns (oldest first) is preserved, because that order is
      // the point of the dashboard.
      const baris = await mesin.monitoringLpj(filter, ctx);
      const peta = await label(baris.map((b) => b.proposalId));
      return baris.map((b) => {
        const l = peta.get(b.proposalId);
        return {
          ...b,
          cabangNama: l?.cabang_nama ?? "",
          bidangKode: l?.bidang_kode ?? "",
          bidangNama: l?.bidang_nama ?? "",
        };
      });
    },
  };
}
