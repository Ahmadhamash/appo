import { canAccessResource } from "@jormall/auth/tenant-policy";
import { isSupportedLocale } from "@jormall/contracts/locales";
import { ResourceKind, ResourceStatus, Weekday } from "@jormall/db/generated/enums";
import { notFound } from "next/navigation";

import { Feedback } from "../../../../components/feedback";
import { SubmitButton } from "../../../../components/submit-button";
import { phaseOneMessages } from "../../../../messages/phase-one";
import { phaseThreeLabel, phaseThreeMessages } from "../../../../messages/phase-three";
import { requirePagePermission, schedulingRepository } from "../../../../server/identity";
import {
  createBranchHoursRuleAction,
  createResourceAction,
  createResourceAvailabilityRuleAction,
  createResourceGroupAction,
  setResourceStatusAction,
  setServiceResourceRequirementAction,
} from "../../actions";

export default async function ResourcesPage({
  params,
  searchParams,
}: PageProps<"/[locale]/dashboard/resources">) {
  const { locale } = await params;
  if (!isSupportedLocale(locale)) notFound();
  const query = await searchParams;
  const access = await requirePagePermission(locale, "resources.read");
  const configuration = await schedulingRepository.listResourceConfiguration(access);
  const canManage = canAccessResource(access, "resources.manage");
  const messages = phaseThreeMessages[locale];
  const phaseOne = phaseOneMessages[locale];
  return (
    <section className="page-stack" aria-labelledby="resources-title">
      <div>
        <p className="eyebrow">{phaseOne.activeOrganization}</p>
        <h1 id="resources-title">{messages.resources}</h1>
      </div>
      <Feedback
        error={typeof query.error === "string" ? query.error : undefined}
        locale={locale}
        notice={typeof query.notice === "string" ? query.notice : undefined}
      />
      {canManage ? (
        <div className="card-grid">
          <section className="panel" aria-labelledby="group-form-title">
            <h2 id="group-form-title">{messages.addResourceGroup}</h2>
            <form action={createResourceGroupAction} className="form-stack">
              <input name="locale" type="hidden" value={locale} />
              <SelectBranch branches={configuration.branches} locale={locale} />
              <label className="field">
                <span className="field-label">{locale === "ar" ? "النوع" : "Type"}</span>
                <select className="select" name="kind" required>
                  {Object.values(ResourceKind).map((kind) => (
                    <option key={kind} value={kind}>
                      {phaseThreeLabel(locale, kind)}
                    </option>
                  ))}
                </select>
              </label>
              <NameFields locale={locale} />
              <SubmitButton>{messages.addResourceGroup}</SubmitButton>
            </form>
          </section>
          <section className="panel" aria-labelledby="resource-form-title">
            <h2 id="resource-form-title">{messages.addResource}</h2>
            <form action={createResourceAction} className="form-stack">
              <input name="locale" type="hidden" value={locale} />
              <label className="field">
                <span className="field-label">{messages.resourceGroup}</span>
                <select className="select" name="groupId" required>
                  {configuration.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {locale === "ar" ? group.nameAr : group.nameEn}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">
                  {locale === "ar" ? "مقدم خدمة مرتبط (اختياري)" : "Linked provider (optional)"}
                </span>
                <select className="select" name="staffProfileId">
                  <option value="">{locale === "ar" ? "بدون" : "None"}</option>
                  {configuration.providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {locale === "ar" ? provider.displayNameAr : provider.displayNameEn}
                    </option>
                  ))}
                </select>
              </label>
              <NameFields locale={locale} />
              <SubmitButton>{messages.addResource}</SubmitButton>
            </form>
          </section>
          <section className="panel" aria-labelledby="requirement-title">
            <h2 id="requirement-title">{messages.requirement}</h2>
            <form action={setServiceResourceRequirementAction} className="form-stack">
              <input name="locale" type="hidden" value={locale} />
              <SelectBranch branches={configuration.branches} locale={locale} />
              <label className="field">
                <span className="field-label">{phaseOne.service}</span>
                <select className="select" name="serviceId" required>
                  {configuration.services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {locale === "ar" ? service.nameAr : service.nameEn}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">{messages.resourceGroup}</span>
                <select className="select" name="resourceGroupId" required>
                  {configuration.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {locale === "ar" ? group.nameAr : group.nameEn}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">{messages.capacity}</span>
                <input
                  className="input"
                  defaultValue="1"
                  max="20"
                  min="1"
                  name="quantity"
                  required
                  type="number"
                />
              </label>
              <SubmitButton>{phaseOne.save}</SubmitButton>
            </form>
          </section>
          <section className="panel" aria-labelledby="hours-title">
            <h2 id="hours-title">{messages.branchHours}</h2>
            <form action={createBranchHoursRuleAction} className="form-stack">
              <input name="locale" type="hidden" value={locale} />
              <SelectBranch branches={configuration.branches} locale={locale} />
              <RuleFields locale={locale} />
              <SubmitButton>{phaseOne.save}</SubmitButton>
            </form>
          </section>
        </div>
      ) : null}
      <div className="card-grid">
        {configuration.groups.map((group) => (
          <article className="record-card" key={group.id}>
            <div>
              <span className="status">{phaseThreeLabel(locale, group.kind)}</span>
              <h2>{locale === "ar" ? group.nameAr : group.nameEn}</h2>
              <p className="muted">
                {group.resources.length} {messages.resources.toLocaleLowerCase(locale)}
              </p>
            </div>
            <ul className="history-list">
              {group.resources.map((resource) => (
                <li key={resource.id}>
                  <strong>{locale === "ar" ? resource.nameAr : resource.nameEn}</strong>
                  <span className="status">{phaseThreeLabel(locale, resource.status)}</span>
                  {canManage ? (
                    <>
                      <form action={setResourceStatusAction} className="inline-form">
                        <input name="locale" type="hidden" value={locale} />
                        <input name="resourceId" type="hidden" value={resource.id} />
                        <select className="select" defaultValue={resource.status} name="status">
                          {Object.values(ResourceStatus).map((status) => (
                            <option key={status} value={status}>
                              {phaseThreeLabel(locale, status)}
                            </option>
                          ))}
                        </select>
                        <SubmitButton tone="secondary">{phaseOne.save}</SubmitButton>
                      </form>
                      <form action={createResourceAvailabilityRuleAction} className="inline-form">
                        <input name="locale" type="hidden" value={locale} />
                        <input name="resourceId" type="hidden" value={resource.id} />
                        <RuleFields locale={locale} />
                        <SubmitButton tone="secondary">{messages.branchHours}</SubmitButton>
                      </form>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function SelectBranch({
  branches,
  locale,
}: Readonly<{
  branches: readonly { id: string; nameAr: string; nameEn: string }[];
  locale: "ar" | "en";
}>) {
  return (
    <label className="field">
      <span className="field-label">{locale === "ar" ? "الفرع" : "Branch"}</span>
      <select className="select" name="branchId" required>
        {branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {locale === "ar" ? branch.nameAr : branch.nameEn}
          </option>
        ))}
      </select>
    </label>
  );
}

function NameFields({ locale }: Readonly<{ locale: "ar" | "en" }>) {
  return (
    <>
      <label className="field">
        <span className="field-label">
          {locale === "ar" ? "الاسم بالإنجليزية" : "English name"}
        </span>
        <input className="input" name="nameEn" required />
      </label>
      <label className="field">
        <span className="field-label">{locale === "ar" ? "الاسم بالعربية" : "Arabic name"}</span>
        <input className="input" dir="rtl" name="nameAr" required />
      </label>
    </>
  );
}

function RuleFields({ locale }: Readonly<{ locale: "ar" | "en" }>) {
  return (
    <>
      <label className="field">
        <span className="field-label">{locale === "ar" ? "اليوم" : "Weekday"}</span>
        <select className="select" name="weekday">
          {Object.values(Weekday).map((day) => (
            <option key={day} value={day}>
              {day}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">
          {locale === "ar" ? "دقيقة البدء بعد منتصف الليل" : "Start minute after midnight"}
        </span>
        <input
          className="input"
          defaultValue="540"
          max="1439"
          min="0"
          name="startMinuteLocal"
          required
          type="number"
        />
      </label>
      <label className="field">
        <span className="field-label">
          {locale === "ar" ? "دقيقة الانتهاء بعد منتصف الليل" : "End minute after midnight"}
        </span>
        <input
          className="input"
          defaultValue="1020"
          max="1440"
          min="1"
          name="endMinuteLocal"
          required
          type="number"
        />
      </label>
    </>
  );
}
