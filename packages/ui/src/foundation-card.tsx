type FoundationCardProperties = Readonly<{
  badge: string;
  description: string;
  localeLabel: string;
  phaseLabel: string;
  statusLabel: string;
  title: string;
}>;

export function FoundationCard(properties: FoundationCardProperties) {
  return (
    <section className="w-full max-w-3xl overflow-hidden rounded-[2rem] border border-emerald-950/10 bg-white shadow-[0_24px_80px_rgba(17,50,36,0.12)]">
      <div className="h-2 bg-gradient-to-r from-emerald-700 via-teal-500 to-amber-400" />
      <div className="p-8 sm:p-12">
        <div className="mb-10 flex items-center justify-between gap-4">
          <p className="m-0 text-sm font-semibold tracking-wide text-emerald-800">JorMall</p>
          <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">
            {properties.localeLabel}
          </span>
        </div>
        <p className="mb-4 text-sm font-medium text-emerald-700">{properties.badge}</p>
        <h1 className="m-0 max-w-2xl text-4xl font-semibold tracking-tight text-balance text-emerald-950 sm:text-5xl">
          {properties.title}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-stone-600">{properties.description}</p>
        <dl className="mt-10 grid gap-2 rounded-2xl border border-stone-200 bg-stone-50 p-5 sm:grid-cols-[1fr_auto] sm:items-center">
          <dt className="text-sm font-medium text-stone-500">{properties.phaseLabel}</dt>
          <dd className="m-0 text-sm font-semibold text-emerald-900">{properties.statusLabel}</dd>
        </dl>
      </div>
    </section>
  );
}
