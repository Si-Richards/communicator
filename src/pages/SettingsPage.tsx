import { Card } from '@/components/ui/card'

const SettingsPage = () => {
  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl p-8 text-center">
        <h1 className="text-2xl font-bold text-foreground mb-4">Settings</h1>
        <p className="text-muted-foreground">Application settings coming soon...</p>
      </Card>
    </div>
  )
}

export default SettingsPage