// Organisation master data reads, with branch scoping applied.
//
// This module is the REFERENCE IMPLEMENTATION of spec 2 rule 3 and spec 16
// scenario 24 ("Login sebagai Maker dari Cabang A, konfirmasi tidak bisa
// melihat atau mengubah data Cabang B, termasuk lewat manipulasi ID di URL
// atau request API langsung"). Two shapes, and every later phase should copy
// them rather than invent a third:
//
//   LIST  -> the query is filtered by the principal's allowed branches, so a
//            branch-bound role simply never sees another branch's rows.
//   BY ID -> the row is fetched by id alone, then its OWN cabang_id is checked
//            against the principal. Manipulating the id in the URL therefore
//            gets a 403, not the row: the id selects the row, the row states
//            its branch, and the branch decides.
//
// Both paths also pin the row to the principal's bumn, so a valid id from
// another reporting entity behaves like a stranger's id rather than leaking
// across tenants (spec 15 #3 says do not BUILD multi-tenant UI, not that ids
// from another entity should resolve).
import { assertCabangAllowed, allowedCabangIds, notFound } from "./deps";
import type { DbPort, Principal } from "./ports";
import { createOrganisasiRepo, type CabangRow, type KaryawanRow, type OrganisasiRepo } from "./repo";

export interface OrganisasiService {
  listCabang(principal: Principal): Promise<CabangRow[]>;
  getCabang(principal: Principal, id: string): Promise<CabangRow>;
  listKaryawan(principal: Principal, cabangId?: string): Promise<KaryawanRow[]>;
  getKaryawan(principal: Principal, id: string): Promise<KaryawanRow>;
}

export interface OrganisasiServiceDeps {
  db: DbPort;
  repo?: OrganisasiRepo;
}

export function createOrganisasiService({
  db,
  repo = createOrganisasiRepo(),
}: OrganisasiServiceDeps): OrganisasiService {
  /** null means "no branch restriction" (Admin Pusat, Auditor). */
  const scope = (principal: Principal): string[] | null => {
    const ids = allowedCabangIds(principal);
    return ids.length === 0 ? null : ids;
  };

  return {
    async listCabang(principal) {
      return repo.listCabang(db, principal.bumnId, scope(principal));
    },

    async getCabang(principal, id) {
      const row = await repo.findCabangById(db, id);
      // Same 404 whether the row does not exist or belongs to another entity:
      // otherwise the endpoint confirms the existence of ids it will not show.
      if (!row || row.bumn_id !== principal.bumnId) throw notFound("Cabang tidak ditemukan");
      assertCabangAllowed(principal, row.id);
      return row;
    },

    async listKaryawan(principal, cabangId) {
      const allowed = scope(principal);
      if (cabangId !== undefined) {
        // An explicit filter is still checked: asking for another branch is a
        // 403, not an empty list, because an empty list looks like "no data"
        // and hides the refusal from the user and from the audit trail.
        assertCabangAllowed(principal, cabangId);
        return repo.listKaryawan(db, [cabangId], principal.bumnId);
      }
      return repo.listKaryawan(db, allowed, principal.bumnId);
    },

    async getKaryawan(principal, id) {
      const row = await repo.findKaryawanById(db, id);
      // Pinned to the entity first: a lintas-cabang role (Admin Pusat,
      // Auditor) is exempt from the BRANCH check, not from the entity
      // boundary, so a valid id belonging to another bumn must not resolve.
      if (!row || row.bumn_id !== principal.bumnId) throw notFound("Karyawan tidak ditemukan");
      assertCabangAllowed(principal, row.cabang_id);
      return row;
    },
  };
}
