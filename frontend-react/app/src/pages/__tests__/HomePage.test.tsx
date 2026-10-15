import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import HomePage from "@/pages/HomePage";

function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <HomePage />
    </MemoryRouter>,
  );
}

describe("HomePage", () => {
  it("muestra la marca y ambos destinos", () => {
    renderHome();

    expect(screen.getByAltText("Agua ReNew")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Marcar asistencia/i })).toHaveAttribute(
      "href",
      "/asistencia",
    );
    expect(screen.getByRole("link", { name: /Panel administrativo/i })).toHaveAttribute(
      "href",
      "/admin/login",
    );
  });
});
