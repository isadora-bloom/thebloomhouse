'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Camera, Upload, X, Loader2, Check } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UploadState = 'idle' | 'previewing' | 'uploading' | 'success' | 'error'

interface CouplePhotoPromptProps {
  weddingId: string
  onDismiss: () => void
  onUploaded?: (url: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateFileName(file: File): string {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const timestamp = Date.now()
  return `couple-photo-${timestamp}.${ext}`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CouplePhotoPrompt({ weddingId, onDismiss, onUploaded }: CouplePhotoPromptProps) {
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const supabase = createClient()

  function handleFileSelect(file: File) {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!validTypes.includes(file.type)) {
      setErrorMessage('Please upload a JPEG, PNG, or WebP image.')
      return
    }

    if (file.size > 10 * 1024 * 1024) {
      setErrorMessage('File size must be under 10MB.')
      return
    }

    setErrorMessage(null)
    setSelectedFile(file)
    setPreviewUrl(URL.createObjectURL(file))
    setUploadState('previewing')
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
  }

  async function handleUpload() {
    if (!selectedFile) return

    setUploadState('uploading')
    setErrorMessage(null)

    try {
      const fileName = generateFileName(selectedFile)
      const storagePath = `${weddingId}/${fileName}`

      const { error: uploadError } = await supabase.storage
        .from('couple-photos')
        .upload(storagePath, selectedFile, {
          cacheControl: '3600',
          upsert: true,
        })

      if (uploadError) {
        throw new Error(uploadError.message)
      }

      const { data: publicUrlData } = supabase.storage
        .from('couple-photos')
        .getPublicUrl(storagePath)

      const publicUrl = publicUrlData.publicUrl

      const { error: updateError } = await supabase
        .from('weddings')
        .update({ couple_photo_url: publicUrl })
        .eq('id', weddingId)

      if (updateError) {
        throw new Error(updateError.message)
      }

      setUploadState('success')
      if (previewUrl) URL.revokeObjectURL(previewUrl)

      if (onUploaded) onUploaded(publicUrl)

      // Close after a brief success pause
      setTimeout(() => {
        onDismiss()
      }, 1200)
    } catch (err) {
      setUploadState('error')
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed. Please try again.')
    }
  }

  function handleSkip() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    onDismiss()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full overflow-hidden">
        {/* Header */}
        <div className="p-6 pb-4 border-b border-gray-100">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                <Camera className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2
                  className="text-xl font-semibold"
                  style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                >
                  Add your couple photo
                </h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  It appears on your wedding website and throughout your portal
                </p>
              </div>
            </div>
            <button
              onClick={handleSkip}
              className="text-gray-400 hover:text-gray-600 shrink-0"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6">
          {uploadState === 'idle' && (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="relative flex flex-col items-center justify-center gap-3 p-8 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 hover:bg-gray-100 hover:border-gray-400 cursor-pointer transition-all"
            >
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center"
                style={{ backgroundColor: '#7D847115' }}
              >
                <Upload className="w-6 h-6" style={{ color: '#7D8471' }} />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-700">
                  Click to choose a photo
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  JPEG, PNG, or WebP (max 10MB)
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          )}

          {uploadState === 'previewing' && previewUrl && (
            <div className="flex flex-col items-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="Preview"
                className="max-w-full rounded-xl shadow-md object-cover"
                style={{ maxHeight: 280 }}
              />
              <p className="text-xs text-gray-500 mt-3">Looks good?</p>
            </div>
          )}

          {uploadState === 'uploading' && (
            <div className="flex flex-col items-center py-10">
              <Loader2 className="w-10 h-10 animate-spin mb-3" style={{ color: '#7D8471' }} />
              <p className="text-sm font-medium text-gray-600">Uploading your photo...</p>
            </div>
          )}

          {uploadState === 'success' && (
            <div className="flex flex-col items-center py-10">
              <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
                <Check className="w-6 h-6 text-green-600" />
              </div>
              <p className="text-sm font-medium text-green-700">Photo saved!</p>
            </div>
          )}

          {errorMessage && (
            <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-100">
              <X className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{errorMessage}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        {(uploadState === 'idle' || uploadState === 'previewing' || uploadState === 'error') && (
          <div className="px-6 pb-6 flex items-center justify-end gap-3">
            <button
              onClick={handleSkip}
              className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Skip for now
            </button>
            <button
              onClick={uploadState === 'previewing' ? handleUpload : () => fileInputRef.current?.click()}
              disabled={uploadState === 'idle' && !selectedFile}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Upload className="w-4 h-4" />
              {uploadState === 'previewing' ? 'Upload' : 'Choose file'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
