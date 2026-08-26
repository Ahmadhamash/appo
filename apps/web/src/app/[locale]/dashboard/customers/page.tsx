import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { phaseTwoMessages } from "../../../../messages/phase-two";
import { crmAppointmentRepository, requirePagePermission } from "../../../../server/identity";
import { createCustomerAction } from "../../actions";

export default async function CustomersPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/customers">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const [access, query] = await Promise.all([
    requirePagePermission(locale, "customers.read"),
    searchParams,
  ]);
  const search = typeof query.q === "string" ? query.q.slice(0, 100) : undefined;
  const customers = await crmAppointmentRepository.listCustomers(access, search);
  const phaseOne = phaseOneMessages[locale];
  const messages = phaseTwoMessages[locale];
  const canWrite = canAccessResource(access, "customers.write");
  return (
    <section className="page-stack" aria-labelledby="customers-title">
      <div>
        <p className="eyebrow">{phaseOne.activeOrganization}</p>
        <h1 id="customers-title">{messages.customers}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      <form action={`/${locale}/dashboard/customers`} className="inline-form" method="get">
        <label className="field">
          <span className="field-label">
            {locale === "ar" ? "بحث بالاسم أو الهاتف" : "Search name or phone"}
          </span>
          <input className="input" defaultValue={search} name="q" />
        </label>
        <SubmitButton tone="secondary">{locale === "ar" ? "بحث" : "Search"}</SubmitButton>
      </form>
      {canWrite ? (
        <form action={createCustomerAction} className="panel form-grid">
          <input name="locale" type="hidden" value={locale} />
          <label className="field">
            <span className="field-label">{phaseOne.name}</span>
            <input className="input" name="displayName" required />
          </label>
          <label className="field">
            <span className="field-label">{phaseOne.phone}</span>
            <input className="input" dir="ltr" name="phoneOriginal" type="tel" />
          </label>
          <label className="field">
            <span className="field-label">{phaseOne.defaultLocale}</span>
            <select className="select" defaultValue={locale} name="preferredLocale">
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          <div className="form-actions">
            <SubmitButton>{messages.createCustomer}</SubmitButton>
          </div>
        </form>
      ) : null}
      <p className="muted">{messages.duplicateHint}</p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">{messages.customers}</caption>
          <thead>
            <tr>
              <th>{phaseOne.name}</th>
              <th>{phaseOne.phone}</th>
              <th>{phaseOne.status}</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.id}>
                <td>
                  <Link href={`/${locale}/dashboard/customers/${customer.id}`}>
                    {customer.displayName}
                  </Link>
                </td>
                <td dir="ltr">{customer.contacts[0]?.originalValue ?? "—"}</td>
                <td>
                  {customer.isArchived
                    ? locale === "ar"
                      ? "مؤرشف"
                      : "Archived"
                    : phaseOneValue(locale, "ACTIVE")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function phaseOneValue(locale: "ar" | "en", value: string): string {
  return locale === "ar" && value === "ACTIVE" ? "نشط" : "Active";
}
