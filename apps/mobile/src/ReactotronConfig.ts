import AsyncStorage from '@react-native-async-storage/async-storage'
import { NativeModules } from 'react-native'
import Reactotron from 'reactotron-react-native'

// Derive the Metro host from the running JS bundle URL so Reactotron connects
// from the iOS simulator (localhost) AND from a physical device on the LAN.
let host = 'localhost'
const scriptURL: string | undefined = NativeModules?.SourceCode?.scriptURL
if (scriptURL) {
  const afterScheme = scriptURL.split('://')[1]
  if (afterScheme) host = afterScheme.split(':')[0].split('/')[0]
}

const reactotron = Reactotron.configure({
  name: 'wolffish-mobile',
  host
})
  .setAsyncStorageHandler(AsyncStorage)
  .useReactNative({
    networking: {
      // Hide Metro/symbolication noise; keep real API traffic (the worker).
      ignoreUrls: /symbolicate|\/(logs|status|hot)$|\.map$/
    }
  })
  .connect()

// Fresh timeline on every JS reload.
reactotron.clear?.()

// Quick logging anywhere: console.tron.log('hi'), console.tron.display({...})
;(console as Console & { tron?: typeof reactotron }).tron = reactotron

export default reactotron
