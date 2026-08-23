// Test helpers shared by the component tests in this app. Not part of the
// bundle: nothing under src/ imports it except *.test.tsx files.
//
// Everything that can change React state goes through `act`. That is not
// ceremony: without it, React 18 hands the update to its scheduler, and the
// scheduler holds a MessageChannel captured from whichever window existed when
// react-dom was first loaded. apps/web/src/server.test.ts and
// apps/web/src/smoke.test.ts both unregister and re-register happy-dom, which
// replaces that window, and from then on scheduler driven updates in a later
// test file silently never flush. Verified empirically: the DataTable sort
// tests passed alone and failed only when a document swapping file ran before
// them. `act` flushes React's work synchronously instead of waiting on the
// scheduler, so these tests no longer depend on file order.
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

// React only enables act's synchronous flushing when this flag is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  unmount: () => void;
  /** Let React flush pending work, including effects that resolve a promise. */
  flush: () => Promise<void>;
}

async function flushAll(): Promise<void> {
  // Two turns: one for the render commit, one for an effect that awaits a
  // promise and then sets state again (the session bootstrap does exactly that).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flushAll();
  return {
    container,
    flush: flushAll,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Click an element the way a user would, and flush the resulting render. */
export async function clickOn(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flushAll();
}

/**
 * Set an input's value the way a user would, going through the native value
 * setter so React's own value tracker sees the change and fires onChange.
 */
export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis.HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flushAll();
}

export function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}
