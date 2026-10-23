import { RunView } from '@/ui/run-view';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <RunView id={(await params).id} report />;
}
