'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { cn } from '@/lib/utils'
import {
  Camera,
  Upload,
  X,
  Loader2,
  Info,
  Check,
  ImageIcon,
} from 'lucide-react'

// TODO: Get from auth session / couple context
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UploadState = 'idle' | 'previewing' | 'uploading' | 'success' | 'error'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateFileName(file: File): string {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const timestamp = Date.now()
  return `couple-photo-${timestamp}.${ext}`
}

// ---------------------------------------------------------------------------
// DropZone
// ---------------------------------------------------------------------------

function DropZone({
  onFileSelect,
  isDragging,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
}: {
  onFileSelect: (file: File) => void
  isDragging: boolean
  onDragEnter: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) onFileSelect(file)
  }

  return (
    <div
      onClick={() => fileInputRef.current?.click()}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        'relative flex flex-col items-center justify-center gap-4 p-12 rounded-xl border-2 border-dashed cursor-pointer transition-all',
        isDragging
          ? 'border-[#7D8471] bg-[#7D8471]/5'
          : 'border-gray-300 bg-white hover:border-gray-400 hover:bg-gray-50'
      )}
    >
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center"
        style={{ backgroundColor: '#7D847115' }}
      >
        <Camera className="w-8 h-8" style={{ color: '#7D8471' }} />
      </div>
      <div className="text-center">
        <p
          className="text-base font-medium mb-1"
          style={{ color: 'var(--couple-primary)' }}
        >
          Upload your couple photo
        </p>
        <p className="text-sm text-gray-400">
          Click to browse or drag and drop
        </p>
        <p className="text-xs text-gray-400 mt-1">
          JPEG, PNG, or WebP accepted
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
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CouplePhotoPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  // ---- Fetch current photo ----
  const fetchCurrentPhoto = useCallback(async () => {
    const { data, error } = await supabase
      .from('weddings')
      .select('couple_photo_url')
      .eq('id', weddingId)
      .single()

    if (!error && data) {
      setCurrentPhotoUrl(data.couple_photo_url || null)
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchCurrentPhoto()
  }, [fetchCurrentPhoto])

  // ---- File select handler ----
  function handleFileSelect(file: File) {
    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!validTypes.includes(file.type)) {
      setErrorMessage('Please upload a JPEG, PNG, or WebP image.')
      return
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      setErrorMessage('File size must be under 10MB.')
      return
    }

    setErrorMessage(null)
    setSelectedFile(file)
    setPreviewUrl(URL.createObjectURL(file))
    setUploadState('previewing')
  }

  // ---- Drag and drop handlers ----
  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const file = e.dataTransfer.files?.[0]
    if (file) handleFileSelect(file)
  }

  // ---- Cancel preview ----
  function handleCancel() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }
    setPreviewUrl(null)
    setSelectedFile(null)
    setUploadState('idle')
    setErrorMessage(null)
  }

  // ---- Upload and save ----
  async function handleSave() {
    if (!selectedFile) return

    setUploadState('uploading')
    setErrorMessage(null)

    try {
      const fileName = generateFileName(selectedFile)
      const storagePath = `${weddingId}/${fileName}`

      // Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('couple-photos')
        .upload(storagePath, selectedFile, {
          cacheControl: '3600',
          upsert: true,
        })

      if (uploadError) {
        throw new Error(uploadError.message)
      }

      // Get public URL
      const { data: publicUrlData } = supabase.storage
        .from('couple-photos')
        .getPublicUrl(storagePath)

      const publicUrl = publicUrlData.publicUrl

      // Update weddings record
      const { error: updateError } = await supabase
        .from('weddings')
        .update({ couple_photo_url: publicUrl })
        .eq('id', weddingId)

      if (updateError) {
        throw new Error(updateError.message)
      }

      // Success
      setCurrentPhotoUrl(publicUrl)
      setUploadState('success')

      // Clean up preview
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
      }
      setPreviewUrl(null)
      setSelectedFile(null)

      // Reset state after showing success
      setTimeout(() => {
        setUploadState('idle')
      }, 2000)
    } catch (err) {
      setUploadState('error')
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed. Please try again.')
    }
  }

  // ---- Change photo handler ----
  function handleChangePhoto() {
    fileInputRef.current?.click()
  }

  function handleChangeFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Camera className="w-6 h-6" style={{ color: 'var(--couple-primary)' }} />
          <h1
            className="text-3xl font-bold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Couple Photo
          </h1>
        </div>
        <p className="text-gray-500 text-sm">
          Your photo appears on your wedding website and portal
        </p>
      </div>

      {/* Main Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-gray-300" />
        </div>
      ) : uploadState === 'previewing' ? (
        /* Preview State — showing selected file before upload */
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex flex-col items-center">
            <p className="text-sm text-gray-500 mb-4">Preview</p>
            {previewUrl && (
              <img
                src={previewUrl}
                alt="Preview"
                className="max-w-md w-full rounded-xl shadow-md mb-6 object-cover"
                style={{ maxHeight: 400 }}
              />
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={handleCancel}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <X className="w-4 h-4" />
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-colors hover:opacity-90"
                style={{ backgroundColor: '#7D8471' }}
              >
                <Upload className="w-4 h-4" />
                Save Photo
              </button>
            </div>
          </div>
        </div>
      ) : uploadState === 'uploading' ? (
        /* Uploading State */
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex flex-col items-center py-12">
            <Loader2 className="w-10 h-10 animate-spin mb-4" style={{ color: '#7D8471' }} />
            <p className="text-sm font-medium text-gray-600">Uploading your photo...</p>
            <p className="text-xs text-gray-400 mt-1">This may take a moment</p>
          </div>
        </div>
      ) : uploadState === 'success' ? (
        /* Success State */
        <div className="bg-white rounded-xl shadow-sm border border-green-200 p-6">
          <div className="flex flex-col items-center py-8">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-4">
              <Check className="w-6 h-6 text-green-600" />
            </div>
            <p className="text-sm font-medium text-green-700">Photo saved successfully!</p>
          </div>
        </div>
      ) : currentPhotoUrl ? (
        /* Current Photo Display */
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex flex-col items-center">
            <img
              src={currentPhotoUrl}
              alt="Couple photo"
              className="max-w-md w-full rounded-xl shadow-md mb-6 object-cover"
              style={{ maxHeight: 400 }}
            />
            <button
              onClick={handleChangePhoto}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-colors hover:opacity-90"
              style={{ backgroundColor: '#7D8471' }}
            >
              <Camera className="w-4 h-4" />
              Change Photo
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleChangeFileInput}
              className="hidden"
            />
          </div>
        </div>
      ) : (
        /* No Photo — Upload placeholder */
        <DropZone
          onFileSelect={handleFileSelect}
          isDragging={isDragging}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        />
      )}

      {/* Error message */}
      {errorMessage && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-100">
          <X className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{errorMessage}</p>
        </div>
      )}

      {/* Tips section */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <div className="flex items-start gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: '#7D847115' }}
          >
            <Info className="w-4 h-4" style={{ color: '#7D8471' }} />
          </div>
          <div>
            <h3
              className="text-sm font-semibold mb-2"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              Photo Tips
            </h3>
            <ul className="space-y-1.5">
              <li className="text-sm text-gray-500 flex items-start gap-2">
                <span className="text-gray-300 mt-0.5">&#8226;</span>
                For best results, use a landscape photo (at least 1200px wide)
              </li>
              <li className="text-sm text-gray-500 flex items-start gap-2">
                <span className="text-gray-300 mt-0.5">&#8226;</span>
                This photo will appear on your public wedding website
              </li>
              <li className="text-sm text-gray-500 flex items-start gap-2">
                <span className="text-gray-300 mt-0.5">&#8226;</span>
                Accepted formats: JPEG, PNG, or WebP (max 10MB)
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
