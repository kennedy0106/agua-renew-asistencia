
import { useEffect, useMemo, useState } from "react";

export const TABLE_PAGE_SIZE = 10;

export function useTablePagination<T>(items: T[], resetKey?: string | number) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / TABLE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  const pageItems = useMemo(
    () => items.slice((safePage - 1) * TABLE_PAGE_SIZE, safePage * TABLE_PAGE_SIZE),
    [items, safePage],
  );

  return { page: safePage, setPage, pageCount, pageItems, total: items.length };
}

export function TablePagination({ page, setPage, pageCount, total }: {
  page: number;
  setPage: (page: number) => void;
  pageCount: number;
  total: number;
}) {
  if (total <= TABLE_PAGE_SIZE) return null;
  const first = (page - 1) * TABLE_PAGE_SIZE + 1;
  const last = Math.min(page * TABLE_PAGE_SIZE, total);
  return (
    <nav className="table-pagination" aria-label="Paginación de tabla">
      <span className="table-pagination-status" aria-live="polite">{first}–{last} de {total}</span>
      <div className="table-pagination-actions">
        <button className="btn btn-outline btn-sm" type="button" onClick={() => setPage(page - 1)} disabled={page === 1} aria-label="Página anterior">Anterior</button>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => setPage(page + 1)} disabled={page === pageCount} aria-label="Página siguiente">Siguiente</button>
      </div>
    </nav>
  );
}
