'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useScope } from '@/lib/hooks/use-scope'
import {
  Users,
  Plus,
  Mail,
  Shield,
  Clock,
  MoreVertical,
  UserMinus,
  ChevronDown,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Building2,
  MapPin,
  Send,
  X,
  RefreshCw,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamMember {
  id: string
  first_name: string | null
  last_name: string | null
  role: string
  venue_id: string | null
  org_id: string | null
  created_at: string | null
  email?: string
  venue_name?: string
  last_sign_in_at?: string | null
}

interface Invitation {
  id: string
  email: string
  role: string
  venue_id: string | null
  status: string
  expires_at: string
  created_at: string
  venues: { name: string } | null
}

interface VenueOption {
  id: string
  name: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLE_OPTIONS = [
  { value: 'org_admin', label: 'Org Admin', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  { value: 'venue_manager', label: 'Venue Manager', color: 'bg-teal-50 text-teal-700 border-teal-200' },
  { value: 'coordinator', label: 'Coordinator', color: 'bg-sage-50 text-sage-700 border-sage-200' },
  { value: 'readonly', label: 'Read-only', color: 'bg-gray-50 text-gray-600 border-gray-200' },
]

const INVITE_ROLE_OPTIONS = [
  { value: 'venue_manager', label: 'Lead Coordinator' },
  { value: 'coordinator', label: 'Coordinator' },
  { value: 'readonly', label: 'Read-only' },
]

function getRoleBadge(role: string) {
  return ROLE_OPTIONS.find((r) => r.value === role) ?? {
    value: role,
    label: role,
    color: 'bg-gray-50 text-gray-600 border-gray-200',
  }
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Team Management Page
// ---------------------------------------------------------------------------

export default function TeamPage() {
  const scope = useScope()
  const [members, setMembers] = useState<TeamMember[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [venues, setVenues] = useState<VenueOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Invite modal
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('coordinator')
  const [inviteVenueId, setInviteVenueId] = useState<string>('')
  const [inviteLoading, setInviteLoading] = useState(false)

  // Role editing
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Load data
  // ---------------------------------------------------------------------------
  const loadData = useCallback(async () => {
    if (scope.loading || !scope.orgId) return
    setLoading(true)

    const supabase = createClient()

    try {
      // 1. Fetch team members
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, first_name, last_name, role, venue_id, org_id, created_at')
        .eq('org_id', scope.orgId)
        .order('created_at', { ascending: true })

      // 2. Fetch auth user emails and last sign-in via individual lookups
      // (We can't query auth.users directly from the client, so we fetch from a joined view or individually)
      const membersWithEmail: TeamMember[] = []
      for (const profile of (profiles ?? [])) {
        // Try to get email from auth user metadata
        const member: TeamMember = {
          ...profile,
          email: undefined,
          venue_name: undefined,
          last_sign_in_at: null,
        }
        membersWithEmail.push(member)
      }

      // 3. Fetch venue names for assignment display
      const { data: venueData } = await supabase
        .from('venues')
        .select('id, name')
        .eq('org_id', scope.orgId)
        .order('name')

      const venueMap = new Map((venueData ?? []).map((v) => [v.id, v.name]))
      setVenues((venueData ?? []).map((v) => ({ id: v.id, name: v.name as string })))

      // Enrich members with venue names
      for (const m of membersWithEmail) {
        if (m.venue_id) {
          m.venue_name = (venueMap.get(m.venue_id) as string) ?? undefined
        }
      }

      setMembers(membersWithEmail)

      // 4. Fetch pending invitations
      const res = await fetch(`/api/team/invite?orgId=${scope.orgId}`)
      const inviteData = await res.json()
      setInvitations(inviteData.invitations ?? [])
    } catch (err) {
      console.error('Failed to load team data:', err)
    }

    setLoading(false)
  }, [scope.loading, scope.orgId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // ---------------------------------------------------------------------------
  // Send invitation
  // ---------------------------------------------------------------------------
  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!inviteEmail.trim()) {
      setError('Please enter an email address.')
      return
    }

    setInviteLoading(true)

    try {
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: inviteRole,
          venueId: inviteVenueId || null,
          orgId: scope.orgId,
        }),
      })

      const data = await res.json()

      if (!res.ok || data.error) {
        setError(data.error || 'Failed to send invitation.')
        setInviteLoading(false)
        return
      }

      setSuccess(`Invitation sent to ${inviteEmail}`)
      setInviteEmail('')
      setShowInvite(false)
      loadData()
    } catch {
      setError('Failed to send invitation.')
    }
    setInviteLoading(false)
  }

  // ---------------------------------------------------------------------------
  // Change role
  // ---------------------------------------------------------------------------
  async function changeRole(memberId: string, newRole: string) {
    const supabase = createClient()
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ role: newRole })
      .eq('id', memberId)

    if (updateError) {
      setError('Failed to update role.')
      return
    }

    setMembers(members.map((m) =>
      m.id === memberId ? { ...m, role: newRole } : m
    ))
    setEditingMemberId(null)
    setSuccess('Role updated.')
    setTimeout(() => setSuccess(null), 3000)
  }

  // ---------------------------------------------------------------------------
  // Change venue assignment
  // ---------------------------------------------------------------------------
  async function changeVenue(memberId: string, newVenueId: string | null) {
    const supabase = createClient()
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ venue_id: newVenueId })
      .eq('id', memberId)

    if (updateError) {
      setError('Failed to update venue assignment.')
      return
    }

    const venueName = newVenueId ? venues.find((v) => v.id === newVenueId)?.name : undefined
    setMembers(members.map((m) =>
      m.id === memberId ? { ...m, venue_id: newVenueId, venue_name: venueName } : m
    ))
    setSuccess('Venue assignment updated.')
    setTimeout(() => setSuccess(null), 3000)
  }

  // ---------------------------------------------------------------------------
  // Remove member
  // ---------------------------------------------------------------------------
  async function removeMember(memberId: string) {
    if (!confirm('Remove this team member? This removes their access but does not delete their account.')) {
      return
    }

    const supabase = createClient()
    const { error: deleteError } = await supabase
      .from('user_profiles')
      .delete()
      .eq('id', memberId)
      .eq('org_id', scope.orgId!)

    if (deleteError) {
      setError('Failed to remove team member.')
      return
    }

    setMembers(members.filter((m) => m.id !== memberId))
    setSuccess('Team member removed.')
    setTimeout(() => setSuccess(null), 3000)
  }

  // ---------------------------------------------------------------------------
  // Revoke invitation
  // ---------------------------------------------------------------------------
  async function revokeInvitation(invitationId: string) {
    const supabase = createClient()
    await supabase
      .from('team_invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId)

    setInvitations(invitations.filter((i) => i.id !== invitationId))
    setSuccess('Invitation revoked.')
    setTimeout(() => setSuccess(null), 3000)
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const pendingInvites = invitations.filter((i) => i.status === 'pending')

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-sage-900">Team</h1>
          <p className="text-sage-600 text-sm mt-1">
            Manage your team members and invitations
          </p>
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          Invite
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="w-4 h-4" /></button>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {success}
        </div>
      )}

      {/* Invite Modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-md shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-lg font-semibold text-sage-900">Invite Team Member</h2>
              <button onClick={() => setShowInvite(false)} className="text-sage-400 hover:text-sage-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleInvite} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className={inputClasses}
                  placeholder="colleague@venue.com"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className={inputClasses}
                >
                  {INVITE_ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>

              {venues.length > 1 && (
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Venue (optional)</label>
                  <select
                    value={inviteVenueId}
                    onChange={(e) => setInviteVenueId(e.target.value)}
                    className={inputClasses}
                  >
                    <option value="">All venues (org-level)</option>
                    {venues.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowInvite(false)}
                  className="px-4 py-2 text-sm font-medium text-sage-600 border border-border rounded-lg hover:bg-sage-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={inviteLoading}
                  className="flex-1 flex items-center justify-center gap-2 bg-sage-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
                >
                  {inviteLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      Send Invitation
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Team Members */}
      <div className="bg-surface border border-border rounded-xl">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
            <Users className="w-4 h-4 text-sage-500" />
            Active Members
            <span className="text-xs font-normal text-sage-500 bg-sage-50 px-2 py-0.5 rounded-full">
              {members.length}
            </span>
          </h2>
          <button
            onClick={loadData}
            className="p-1.5 text-sage-400 hover:text-sage-600 transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center">
            <Loader2 className="w-6 h-6 text-sage-400 animate-spin mx-auto" />
          </div>
        ) : members.length === 0 ? (
          <div className="p-8 text-center text-sm text-sage-500">
            No team members yet. Invite your first team member above.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {members.map((member) => {
              const badge = getRoleBadge(member.role)
              const isEditing = editingMemberId === member.id

              return (
                <div key={member.id} className="px-6 py-4 flex items-center gap-4 hover:bg-sage-50/40 transition-colors">
                  {/* Avatar */}
                  <div className="w-10 h-10 bg-sage-100 rounded-full flex items-center justify-center shrink-0">
                    <span className="text-sm font-semibold text-sage-600">
                      {(member.first_name?.[0] ?? '').toUpperCase()}
                      {(member.last_name?.[0] ?? '').toUpperCase()}
                    </span>
                  </div>

                  {/* Name & email */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-sage-800 truncate">
                      {member.first_name} {member.last_name}
                    </p>
                    {member.email && (
                      <p className="text-xs text-sage-500 truncate">{member.email}</p>
                    )}
                  </div>

                  {/* Venue */}
                  {venues.length > 1 && (
                    <div className="hidden sm:block">
                      <select
                        value={member.venue_id ?? ''}
                        onChange={(e) => changeVenue(member.id, e.target.value || null)}
                        className="text-xs border border-border rounded-md px-2 py-1 text-sage-600 bg-warm-white"
                      >
                        <option value="">All venues</option>
                        {venues.map((v) => (
                          <option key={v.id} value={v.id}>{v.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {venues.length === 1 && member.venue_name && (
                    <div className="hidden sm:flex items-center gap-1 text-xs text-sage-500">
                      <MapPin className="w-3 h-3" />
                      {member.venue_name}
                    </div>
                  )}

                  {/* Role badge / editor */}
                  {isEditing ? (
                    <select
                      value={member.role}
                      onChange={(e) => changeRole(member.id, e.target.value)}
                      onBlur={() => setEditingMemberId(null)}
                      autoFocus
                      className="text-xs border border-sage-300 rounded-md px-2 py-1 text-sage-700 bg-warm-white focus:ring-2 focus:ring-sage-300"
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  ) : (
                    <button
                      onClick={() => setEditingMemberId(member.id)}
                      className={`text-xs font-medium px-2 py-1 rounded-full border ${badge.color} hover:opacity-80 transition-opacity cursor-pointer`}
                      title="Click to change role"
                    >
                      {badge.label}
                    </button>
                  )}

                  {/* Last active */}
                  <div className="hidden md:flex items-center gap-1 text-xs text-sage-400 w-20 justify-end">
                    <Clock className="w-3 h-3" />
                    {formatTimeAgo(member.last_sign_in_at ?? member.created_at)}
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => removeMember(member.id)}
                    className="p-1.5 text-sage-300 hover:text-red-500 transition-colors"
                    title="Remove member"
                  >
                    <UserMinus className="w-4 h-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Pending Invitations */}
      {pendingInvites.length > 0 && (
        <div className="bg-surface border border-border rounded-xl">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
              <Mail className="w-4 h-4 text-sage-500" />
              Pending Invitations
              <span className="text-xs font-normal text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                {pendingInvites.length}
              </span>
            </h2>
          </div>

          <div className="divide-y divide-border">
            {pendingInvites.map((invite) => {
              const badge = getRoleBadge(invite.role)
              const expiresIn = Math.ceil(
                (new Date(invite.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              )

              return (
                <div key={invite.id} className="px-6 py-4 flex items-center gap-4">
                  <div className="w-10 h-10 bg-amber-50 rounded-full flex items-center justify-center shrink-0">
                    <Mail className="w-4 h-4 text-amber-500" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-sage-800 truncate">{invite.email}</p>
                    <p className="text-xs text-sage-500">
                      Expires in {expiresIn} day{expiresIn !== 1 ? 's' : ''}
                      {invite.venues?.name && ` | ${invite.venues.name}`}
                    </p>
                  </div>

                  <span className={`text-xs font-medium px-2 py-1 rounded-full border ${badge.color}`}>
                    {badge.label}
                  </span>

                  <button
                    onClick={() => revokeInvitation(invite.id)}
                    className="text-xs text-sage-400 hover:text-red-500 font-medium transition-colors"
                  >
                    Revoke
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
