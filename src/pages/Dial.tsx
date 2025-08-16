import { MultiCallInterface } from '@/components/MultiCallInterface'
import { SimpleMultiCallProvider, useSimpleMultiCallContext } from '@/contexts/SimpleMultiCallContext'

const DialContent = () => {
  return (
    <div className="min-h-full flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <MultiCallInterface />
      </div>
    </div>
  )
}

const Dial = () => {
  return (
    <SimpleMultiCallProvider>
      <DialContent />
    </SimpleMultiCallProvider>
  )
}

export default Dial