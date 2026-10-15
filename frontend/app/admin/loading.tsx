import { StatSkeleton, TableSkeleton } from "@/components/Loading";

/** App Router fallback for every admin route while its page chunk/data becomes ready. */
export default function AdminLoading() {
  return (
    <main className="admin-loading" aria-busy="true" aria-label="Cargando sección administrativa">
      <div className="card card-pad" style={{ marginBottom: "1rem" }}>
        <div className="skeleton" style={{ width: "min(19rem, 70%)", height: 34 }} />
        <div className="skeleton" style={{ width: "min(29rem, 90%)", height: 14, marginTop: "0.65rem" }} />
      </div>
      <StatSkeleton count={4} />
      <div className="table-wrap" style={{ marginTop: "1rem" }}><table className="table"><tbody><TableSkeleton rows={5} cols={5} /></tbody></table></div>
    </main>
  );
}
