import { SocialChannelsWorkspace } from "@/components/marketing/social-channels-workspace";

export const dynamic = "force-dynamic";

export default function SocialChannelsPage() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col">
      <SocialChannelsWorkspace />
    </div>
  );
}
