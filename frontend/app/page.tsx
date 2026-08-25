export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 font-sans">
      <main className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-sky-600 text-3xl">
          💧
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            Agua ReNew
          </h1>
          <p className="text-lg text-zinc-600">
            Sistema de Asistencia
          </p>
        </div>
        <p className="text-sm leading-6 text-zinc-500">
          El registro de entrada y salida estará disponible aquí en las
          próximas fases.
        </p>
        <span className="rounded-full border border-zinc-200 px-4 py-1.5 text-xs font-medium text-zinc-400">
          Fase 0 — base del proyecto
        </span>
      </main>
    </div>
  );
}
