import { afterEach, describe, expect, test } from "bun:test";
import { DataTable, UNPARSEABLE, type Column } from "@krakatausteel/ui";
import { clickOn, mount, textOf } from "./testing";

interface Row {
  kode: string;
  nama: string;
  outstanding: string;
}

const columns: readonly Column<Row>[] = [
  { key: "kode", header: "Kode Mitra", sortable: true },
  { key: "nama", header: "Nama", sortable: true },
  { key: "outstanding", header: "Outstanding", type: "money", sortable: true },
];

const rows: readonly Row[] = [
  { kode: "MB-003", nama: "Cahaya Bakery", outstanding: "2500000.00" },
  { kode: "MB-001", nama: "Anugerah Konveksi", outstanding: "12000000.50" },
  { kode: "MB-002", nama: "Baraka Tani", outstanding: "0" },
];

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return [...container.querySelectorAll("tbody tr")] as HTMLTableRowElement[];
}

function columnValues(container: HTMLElement, index: number): string[] {
  return bodyRows(container).map((row) => textOf(row.cells[index]));
}

describe("<DataTable />", () => {
  test("renders a header per column and a row per record", async () => {
    const view = await mount(<DataTable columns={columns} rows={rows} rowKey={(row) => row.kode} />);
    const headers = [...view.container.querySelectorAll("thead th")].map(textOf);
    expect(headers).toEqual(["Kode Mitra", "Nama", "Outstanding"]);
    expect(bodyRows(view.container)).toHaveLength(3);
    view.unmount();
  });

  test("money columns are right aligned and formatted, zero shown as 0,00", async () => {
    const view = await mount(<DataTable columns={columns} rows={rows} rowKey={(row) => row.kode} />);
    const cells = bodyRows(view.container).map((row) => row.cells[2]);
    for (const cell of cells) expect(cell.className).toContain("is-numeric");
    expect(cells.map(textOf)).toEqual(["2.500.000,00", "12.000.000,50", "0,00"]);
    view.unmount();
  });

  test("a figure that cannot be read is marked, never rendered as 0,00", async () => {
    // The failure mode this guards: a silent zero in place of a real figure is
    // indistinguishable from a real zero balance on a report an auditor signs.
    // formatMoney throws outside production, so this is the production path.
    const realNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const broken: readonly Row[] = [
        { kode: "MB-004", nama: "Data Rusak", outstanding: "dua juta" },
      ];
      const view = await mount(
        <DataTable columns={columns} rows={broken} rowKey={(row) => row.kode} />,
      );
      const cell = bodyRows(view.container)[0].cells[2];
      expect(textOf(cell)).toBe(UNPARSEABLE);
      expect(textOf(cell)).not.toBe("0,00");
      expect(textOf(cell)).not.toContain("0");
      // The value that actually arrived stays reachable for whoever chases it.
      expect(cell.querySelector(".cell-invalid")?.getAttribute("title")).toContain("dua juta");
      view.unmount();
    } finally {
      if (realNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = realNodeEnv;
    }
  });

  test("sorts ascending on the first header click and descending on the second", async () => {
    const view = await mount(<DataTable columns={columns} rows={rows} rowKey={(row) => row.kode} />);
    const sortButtons = [...view.container.querySelectorAll("thead .th-sort")] as HTMLElement[];
    expect(sortButtons).toHaveLength(3);

    // Unsorted, the table keeps the incoming order.
    expect(columnValues(view.container, 0)).toEqual(["MB-003", "MB-001", "MB-002"]);

    await clickOn(sortButtons[0]);
    expect(columnValues(view.container, 0)).toEqual(["MB-001", "MB-002", "MB-003"]);
    expect(view.container.querySelectorAll("thead th")[0].getAttribute("aria-sort")).toBe(
      "ascending",
    );

    await clickOn(sortButtons[0]);
    expect(columnValues(view.container, 0)).toEqual(["MB-003", "MB-002", "MB-001"]);
    expect(view.container.querySelectorAll("thead th")[0].getAttribute("aria-sort")).toBe(
      "descending",
    );

    view.unmount();
  });

  test("sorts a money column numerically, not as text", async () => {
    const view = await mount(<DataTable columns={columns} rows={rows} rowKey={(row) => row.kode} />);
    const sortButtons = [...view.container.querySelectorAll("thead .th-sort")] as HTMLElement[];
    await clickOn(sortButtons[2]);
    // Text sorting would have put "12000000.50" before "2500000.00".
    expect(columnValues(view.container, 2)).toEqual(["0,00", "2.500.000,00", "12.000.000,50"]);
    view.unmount();
  });

  test("shows a deliberate empty state instead of an empty body", async () => {
    const view = await mount(
      <DataTable
        columns={columns}
        rows={[]}
        emptyTitle="Belum ada Mitra Binaan"
        emptyDescription="Data terisi setelah proposal pertama dicairkan."
      />,
    );
    expect(textOf(view.container.querySelector(".table-state"))).toContain(
      "Belum ada Mitra Binaan",
    );
    expect(textOf(view.container.querySelector(".table-state"))).toContain(
      "Data terisi setelah proposal pertama dicairkan.",
    );
    view.unmount();
  });

  test("renders a loading state while data is in flight", async () => {
    const view = await mount(<DataTable columns={columns} rows={[]} loading />);
    expect(textOf(view.container.querySelector(".table-state"))).toBe("Memuat data");
    view.unmount();
  });

  test("renders a footer row only when a column declares one", async () => {
    const withTotal: readonly Column<Row>[] = [
      ...columns.slice(0, 2),
      { ...columns[2], footer: "14.500.000,50" },
    ];
    const view = await mount(
      <DataTable columns={withTotal} rows={rows} rowKey={(row) => row.kode} />,
    );
    expect(textOf(view.container.querySelector("tfoot"))).toContain("14.500.000,50");
    view.unmount();

    const plain = await mount(<DataTable columns={columns} rows={rows} rowKey={(row) => row.kode} />);
    expect(plain.container.querySelector("tfoot")).toBeNull();
    plain.unmount();
  });
});
