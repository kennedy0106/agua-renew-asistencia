import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AdminViewStateProvider, useAdminViewState } from "@/components/AdminViewState";

function wrapper({ children }: { children: ReactNode }) {
  return <AdminViewStateProvider>{children}</AdminViewStateProvider>;
}

describe("AdminViewState · memoria volátil de sesión", () => {
  it("funciona sin provider como useState aislado", () => {
    const { result } = renderHook(() => useAdminViewState("standalone.search", "inicial"));

    expect(result.current[0]).toBe("inicial");

    act(() => result.current[1]("actualizado"));
    expect(result.current[0]).toBe("actualizado");

    act(() => result.current[1]((previous) => `${previous}!`));
    expect(result.current[0]).toBe("actualizado!");
  });

  it("comparte el valor entre consumidores de la misma sesión y clave", () => {
    const { result } = renderHook(
      () => ({
        first: useAdminViewState("shared.search", ""),
        second: useAdminViewState("shared.search", ""),
      }),
      { wrapper },
    );

    act(() => result.current.first[1]("ana"));

    expect(result.current.first[0]).toBe("ana");
    expect(result.current.second[0]).toBe("ana");

    act(() => result.current.second[1]((previous) => `${previous}.torres`));
    expect(result.current.first[0]).toBe("ana.torres");
  });

  it("evalúa el inicializador lazy una sola vez por montaje", () => {
    const initializer = vi.fn(() => "lazy");
    const { result, rerender } = renderHook(
      () => useAdminViewState("lazy.value", initializer),
      { wrapper },
    );

    expect(result.current[0]).toBe("lazy");
    expect(initializer).toHaveBeenCalledTimes(1);

    act(() => result.current[1]("otro"));
    rerender();
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  it("una sesión nueva arranca sin valores de la anterior", () => {
    function Consumer() {
      const [value, setValue] = useAdminViewState("session.search", "");
      return (
        <>
          <output data-testid="value">{value}</output>
          <button type="button" onClick={() => setValue("borrador")}>
            editar
          </button>
        </>
      );
    }

    const first = render(
      <AdminViewStateProvider key="user-a">
        <Consumer />
      </AdminViewStateProvider>,
    );
    act(() => screen.getByRole("button", { name: "editar" }).click());
    expect(screen.getByTestId("value")).toHaveTextContent("borrador");
    first.unmount();

    render(
      <AdminViewStateProvider key="user-b">
        <Consumer />
      </AdminViewStateProvider>,
    );
    expect(screen.getByTestId("value")).toHaveTextContent("");
  });

  it("actualizar una clave solo vuelve a renderizar a sus consumidores", () => {
    const rendersA = vi.fn();
    const rendersB = vi.fn();

    function ConsumerA() {
      const [value, setValue] = useAdminViewState("module.a", 0);
      rendersA(value);
      return (
        <button type="button" onClick={() => setValue((previous) => previous + 1)}>
          sumar a
        </button>
      );
    }

    function ConsumerB() {
      const [value] = useAdminViewState("module.b", "estable");
      rendersB(value);
      return <output data-testid="b">{value}</output>;
    }

    render(
      <AdminViewStateProvider>
        <ConsumerA />
        <ConsumerB />
      </AdminViewStateProvider>,
    );

    const bRendersBefore = rendersB.mock.calls.length;
    act(() => screen.getByRole("button", { name: "sumar a" }).click());

    expect(rendersA).toHaveBeenLastCalledWith(1);
    expect(rendersB.mock.calls.length).toBe(bRendersBefore);
  });

  it("aísla los valores por clave dentro de la misma sesión", () => {
    const { result } = renderHook(
      () => ({
        search: useAdminViewState("module.search", ""),
        status: useAdminViewState<"" | "active">("module.status", ""),
      }),
      { wrapper },
    );

    act(() => result.current.search[1]("texto"));
    act(() => result.current.status[1]("active"));

    expect(result.current.search[0]).toBe("texto");
    expect(result.current.status[0]).toBe("active");
  });

  it("un setter funcional devuelve el mismo valor y evita renderizados", () => {
    let renders = 0;
    function Consumer() {
      const [value, setValue] = useAdminViewState("same.value", "igual");
      renders += 1;
      return (
        <button type="button" onClick={() => setValue((previous) => previous)}>
          {value}
        </button>
      );
    }

    render(
      <AdminViewStateProvider>
        <Consumer />
      </AdminViewStateProvider>,
    );
    const before = renders;

    act(() => screen.getByRole("button", { name: "igual" }).click());
    expect(renders).toBe(before);
  });

  it("mantiene los valores tras desmontar y remontar consumidores del mismo provider", () => {
    function Consumer() {
      const [value, setValue] = useAdminViewState("persist.search", "");
      return (
        <>
          <input
            aria-label="búsqueda"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </>
      );
    }

    const view = render(
      <AdminViewStateProvider>
        <Consumer />
      </AdminViewStateProvider>,
    );
    act(() => {
      const input = screen.getByRole("textbox", { name: "búsqueda" });
      input.focus();
    });
    fireEvent.change(screen.getByRole("textbox", { name: "búsqueda" }), {
      target: { value: "operario" },
    });
    view.rerender(
      <AdminViewStateProvider>
        <div />
      </AdminViewStateProvider>,
    );
    expect(screen.queryByRole("textbox", { name: "búsqueda" })).toBeNull();

    view.rerender(
      <AdminViewStateProvider>
        <Consumer />
      </AdminViewStateProvider>,
    );
    expect(screen.getByRole("textbox", { name: "búsqueda" })).toHaveValue("operario");
  });
});
