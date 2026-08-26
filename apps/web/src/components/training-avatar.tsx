import type {
  GymAvatarFrameValue,
  GymAvatarHairStyleValue,
  GymAvatarSkinToneValue,
} from "@jormall/domain/gym";

export function TrainingAvatar({
  frame,
  hairStyle,
  label,
  shirtColor,
  skinTone,
  size = "large",
}: Readonly<{
  frame: GymAvatarFrameValue;
  hairStyle: GymAvatarHairStyleValue;
  label: string;
  shirtColor: string;
  size?: "compact" | "large";
  skinTone: GymAvatarSkinToneValue;
}>) {
  return (
    <figure className={`training-avatar training-avatar-${size}`} aria-label={label}>
      <div
        aria-hidden="true"
        className="avatar-stage"
        data-frame={frame.toLowerCase()}
        data-hair={hairStyle.toLowerCase()}
        data-skin={skinTone.toLowerCase()}
        style={{ "--avatar-shirt": shirtColor } as React.CSSProperties}
      >
        <span className="avatar-shadow" />
        <span className="avatar-person">
          <span className="avatar-head">
            <span className="avatar-hair" />
            <span className="avatar-face" />
          </span>
          <span className="avatar-body" />
          <span className="avatar-arm avatar-arm-start" />
          <span className="avatar-arm avatar-arm-end" />
          <span className="avatar-leg avatar-leg-start" />
          <span className="avatar-leg avatar-leg-end" />
        </span>
        <span className="avatar-orbit avatar-orbit-one" />
        <span className="avatar-orbit avatar-orbit-two" />
      </div>
    </figure>
  );
}
