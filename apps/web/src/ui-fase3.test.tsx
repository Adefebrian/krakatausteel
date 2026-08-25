// The primitives Fase 3 added to @krakatausteel/ui, tested where react-dom
// lives (packages/ui has no DOM dependency of its own, which is why
// DataTable.test.tsx sits here too).
import { describe, expect, test } from "bun:test";
import { useState } from "react";
import {
  ConfirmDialog,
  DataList,
  ErrorState,
  FilePicker,
  MoneyInput,
  Stat,
  Tabs,
} from "@krakatausteel/ui";
import { clickOn, mount, textOf, typeInto } from "./testing";

describe("Tabs", () => {
  test("is a real tablist: one selected tab, every tab a button", async () => {
    function Harness() {
      const [active, setActive] = useState("a");
      return (
        <Tabs
          label="Sumber pengajuan"
          active={active}
          onChange={setActive}
          items={[
            { id: "a", label: "Daftar Pemohon", count: 3 },
            { id: "b", label: "Daftar Pemohon Online", count: 1 },
          ]}
        />
      );
    }
    const view = await mount(<Harness />);
    const tabs = [...view.container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];

    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");

    await clickOn(tabs[1]!);
    const after = [...view.container.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(after[1]?.getAttribute("aria-selected")).toBe("true");
    view.unmount();
  });

  test("the count sits inside the same button, so the tap target is one rectangle", async () => {
    const view = await mount(
      <Tabs
        label="Sumber"
        active="a"
        onChange={() => {}}
        items={[{ id: "a", label: "Daftar Pemohon", count: 12 }]}
      />,
    );
    const tab = view.container.querySelector('[role="tab"]')!;
    expect(tab.querySelector(".tabs-count")).toBeTruthy();
    expect(textOf(tab)).toContain("12");
    view.unmount();
  });
});

describe("ErrorState", () => {
  test("says what failed, repeats the server verbatim, and names the endpoint", async () => {
    const view = await mount(
      <ErrorState
        title="Gagal memuat daftar proposal"
        detail="Permintaan ke /pumk/proposal ditolak server (404)"
        sumber="GET /api/pumk/proposal"
        onRetry={() => {}}
      />,
    );
    const teks = textOf(view.container);
    expect(teks).toContain("Gagal memuat daftar proposal");
    expect(teks).toContain("ditolak server (404)");
    expect(teks).toContain("GET /api/pumk/proposal");
    // It announces itself, because a silent failure is the thing being avoided.
    expect(view.container.querySelector('[role="alert"]')).toBeTruthy();
    view.unmount();
  });

  test("retry calls back, so a transient failure does not need a page reload", async () => {
    let dicoba = 0;
    const view = await mount(
      <ErrorState title="Gagal memuat" onRetry={() => (dicoba += 1)} />,
    );
    await clickOn(view.container.querySelector(".btn")!);
    expect(dicoba).toBe(1);
    view.unmount();
  });
});

describe("MoneyInput", () => {
  test("emits the API's Uang string, not a JavaScript number", async () => {
    const dilihat: Array<string | null> = [];
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <MoneyInput
          id="uji"
          value={value}
          onValueChange={(parsed) => {
            dilihat.push(parsed);
            setValue(parsed ?? "");
          }}
        />
      );
    }
    const view = await mount(<Harness />);
    await typeInto(view.container.querySelector("#uji") as HTMLInputElement, "1.500.000,50");
    expect(dilihat.at(-1)).toBe("1500000.50");
    expect(typeof dilihat.at(-1)).toBe("string");
    view.unmount();
  });

  test("text it cannot read is reported as null, never as zero", async () => {
    const dilihat: Array<string | null> = [];
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <MoneyInput
          id="uji"
          value={value}
          onValueChange={(parsed) => {
            dilihat.push(parsed);
            setValue(parsed ?? "");
          }}
        />
      );
    }
    const view = await mount(<Harness />);
    await typeInto(view.container.querySelector("#uji") as HTMLInputElement, "dua juta");
    expect(dilihat.at(-1)).toBeNull();
    expect(dilihat).not.toContain("0.00");
    view.unmount();
  });
});

describe("ConfirmDialog", () => {
  test("an irreversible action stays disarmed until the phrase is typed", async () => {
    let dikonfirmasi = 0;
    const view = await mount(
      <ConfirmDialog
        open
        title="Hapus buku piutang macet"
        confirmLabel="Hapus buku"
        tone="danger"
        confirmPhrase="HAPUS BUKU"
        onConfirm={() => (dikonfirmasi += 1)}
        onCancel={() => {}}
      />,
    );

    const konfirmasi = [...view.container.querySelectorAll(".modal-foot .btn")].at(
      -1,
    ) as HTMLButtonElement;
    expect(konfirmasi.disabled).toBe(true);

    await typeInto(view.container.querySelector("#confirm-phrase-input") as HTMLInputElement, "HAPUS BUKU");
    await view.flush();

    const sesudah = [...view.container.querySelectorAll(".modal-foot .btn")].at(
      -1,
    ) as HTMLButtonElement;
    expect(sesudah.disabled).toBe(false);
    await clickOn(sesudah);
    expect(dikonfirmasi).toBe(1);
    view.unmount();
  });

  test("an ordinary confirmation needs no phrase, only a deliberate second click", async () => {
    let dikonfirmasi = 0;
    const view = await mount(
      <ConfirmDialog
        open
        title="Catat pencairan"
        confirmLabel="Catat pencairan"
        onConfirm={() => (dikonfirmasi += 1)}
        onCancel={() => {}}
      />,
    );
    await clickOn([...view.container.querySelectorAll(".modal-foot .btn")].at(-1)!);
    expect(dikonfirmasi).toBe(1);
    view.unmount();
  });
});

describe("DataList and Stat", () => {
  test("a money row is marked numeric so it lines up with the tables", async () => {
    const view = await mount(
      <DataList
        items={[
          { label: "Outstanding pokok", value: "13.750.000,00", numeric: true },
          { label: "Alamat", value: "Jalan Merdeka 1", wide: true },
        ]}
      />,
    );
    expect(view.container.querySelector(".datalist-val.is-numeric")).toBeTruthy();
    expect(view.container.querySelector(".datalist-row.is-wide")).toBeTruthy();
    expect(textOf(view.container)).toContain("13.750.000,00");
    view.unmount();
  });

  test("Stat renders what it is given and formats nothing itself", async () => {
    const view = await mount(<Stat label="Outstanding" value="0,00" hint="Per hari ini" />);
    expect(textOf(view.container.querySelector(".stat-value"))).toBe("0,00");
    view.unmount();
  });
});

describe("FilePicker", () => {
  test("holds the chosen files and reports removal, and stores nothing itself", async () => {
    const berkas = [new File(["x"], "foto-usaha.jpg", { type: "image/jpeg" })];
    let sisa: readonly File[] | null = null;
    const view = await mount(
      <FilePicker
        label="Pilih foto"
        files={berkas}
        onChange={(next) => {
          sisa = next;
        }}
      />,
    );
    expect(textOf(view.container)).toContain("foto-usaha.jpg");
    await clickOn(view.container.querySelector(".filepicker-item .icon-btn")!);
    expect(sisa).toHaveLength(0);
    view.unmount();
  });
});
