{/**

Heliactyl Next - codename "Toledo"
© 2024 Matt James and contributors

*/}

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SettingsProvider } from './hooks/useSettings'
import App from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('heliactyl')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter 
        basename="/"
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true
        }}
      >
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)