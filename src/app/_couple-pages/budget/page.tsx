'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  DollarSign,
  Plus,
  X,
  Edit2,
  Trash2,
  TrendingUp,
  TrendingDown,
  CreditCard,
  Receipt,
  Wallet,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
  PiggyBank,
  Calendar,
  Search,
  Share2,
  Banknote,
  Building,
  Gift,
  Users,
  MoreHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaymentRecord {
  id: string
  budget_item_id: string
  amount: number
  payment_date: string
  payment_method: string
  notes: string | null
}

interface BudgetItem {
  id: string
  category: string
  item_name: string
  budgeted: number
  committed: number
  paid: number
  payment_source: string | null
  payment_due_date: string | null
  notes: string | null
  sort_order: number
  payments?: PaymentRecord[]
}

interface BudgetFormData {
  category: string
  item_name: string
  budgeted: string
  committed: string
  payment_source: string
  payment_due_date: string
  notes: string
}

interface PaymentFormData {
  amount: string
  date: string
  method: string
  notes: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORIES = [
  'Catering/Food',
  'Photography',
  'Videography',
  'Flowers & Florals',
  'Music (DJ/Band)',
  'Cake & Desserts',
  'Officiant',
  'Hair & Makeup',
  'Attire & Accessories',
  'Other',
]

const PAYMENT_SOURCES = [
  'Couple',
  'Parents of Bride',
  'Parents of Groom',
  'Wedding Party',
  'Credit Card',
  'Savings',
  'Gift',
  'Other',
]

const PAYMENT_METHODS = [
  'Credit Card',
  'Check',
  'Bank Transfer',
  'Cash',
  'Venmo/Zelle',
]

const SOURCE_ICONS: Record<string, React.ReactNode> = {
  Couple: <Users className="w-3 h-3" />,
  'Parents of Bride': <Building className="w-3 h-3" />,
  'Parents of Groom': <Building className="w-3 h-3" />,
  'Wedding Party': <Users className="w-3 h-3" />,
  'Credit Card': <CreditCard className="w-3 h-3" />,
  Savings: <PiggyBank className="w-3 h-3" />,
  Gift: <Gift className="w-3 h-3" />,
  Other: <MoreHorizontal className="w-3 h-3" />,
}

const EMPTY_FORM: BudgetFormData = {
  category: '',
  item_name: '',
  budgeted: '',
  committed: '',
  payment_source: '',
  payment_due_date: '',
  notes: '',
}

const EMPTY_PAYMENT: PaymentFormData = {
  amount: '',
  date: new Date().toISOString().split('T')[0],
  method: 'Credit Card',
  notes: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatDueDate(dateStr: string | null): { text: string; color: string } {
  if (!dateStr) return { text: '', color: '' }
  const due = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const diffMs = due.getTime() - now.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 0) return { text: `${Math.abs(diffDays)}d overdue`, color: 'text-red-600 bg-red-50' }
  if (diffDays === 0) return { text: 'Due today', color: 'text-amber-700 bg-amber-50' }
  if (diffDays === 1) return { text: 'Tomorrow', color: 'text-amber-600 bg-amber-50' }
  if (diffDays <= 7) return { text: `in ${diffDays} days`, color: 'text-blue-600 bg-blue-50' }
  if (diffDays <= 14) return { text: 'in 2 weeks', color: 'text-gray-500 bg-gray-50' }
  const formatted = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return { text: formatted, color: 'text-gray-500 bg-gray-50' }
}

// ---------------------------------------------------------------------------
// Budget Page
// ---------------------------------------------------------------------------

export default function BudgetPage() {
  const [items, setItems] = useState<BudgetItem[]>([])
  const [loading, setLoading] = useState(true)
  const [totalBudget, setTotalBudget] = useState(0)
  const [editingBudget, setEditingBudget] = useState(false)
  const [budgetInput, setBudgetInput] = useState('')
  const [showItemModal, setShowItemModal] = useState(false)
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [showCategoryModal, setShowCategoryModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [paymentItemId, setPaymentItemId] = useState<string | null>(null)
  const [form, setForm] = useState<BudgetFormData>(EMPTY_FORM)
  const [paymentForm, setPaymentForm] = useState<PaymentFormData>(EMPTY_PAYMENT)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [expandedPayments, setExpandedPayments] = useState<Set<string>>(new Set())
  const [customCategories, setCustomCategories] = useState<string[]>([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [shareWithVenue, setShareWithVenue] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const supabase = createClient()
  const allCategories = useMemo(() => [...DEFAULT_CATEGORIES, ...customCategories], [customCategories])

  // ---- Fetch ----
  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from('budget_items')
      .select('*, budget_payments(*)')
      .eq('wedding_id', WEDDING_ID)
      .order('sort_order', { ascending: true })

    if (error) {
      console.error('[budget] fetchItems failed:', error)
      setLoading(false)
      return
    }

    if (data) {
      const mapped = data.map((d: Record<string, unknown>) => {
        const paidColumn = Number(d.paid) || 0
        const payments = ((d.budget_payments || []) as PaymentRecord[])
        const paymentsSum = payments.reduce(
          (sum: number, p: PaymentRecord) => sum + (Number(p.amount) || 0),
          0
        )
        return {
          id: d.id as string,
          category: (d.category as string) || 'Other',
          item_name: (d.item_name as string) || '',
          budgeted: Number(d.budgeted) || 0,
          committed: Number(d.committed) || 0,
          // Prefer payments sum when payments exist; otherwise fall back
          // to the budget_items.paid column (used by seed data).
          paid: paymentsSum > 0 ? paymentsSum : paidColumn,
          payment_source: d.payment_source as string | null,
          payment_due_date: d.payment_due_date as string | null,
          notes: d.notes as string | null,
          sort_order: (d.sort_order as number) || 0,
          payments,
        }
      })
      setItems(mapped)
      // Custom categories = anything on an item that isn't a default category
      const customs = [
        ...new Set(
          mapped
            .map((i) => i.category)
            .filter((c) => c && !DEFAULT_CATEGORIES.includes(c))
        ),
      ]
      setCustomCategories(customs)
    }
    setLoading(false)
  }, [supabase])

  const fetchBudgetConfig = useCallback(async () => {
    const { data } = await supabase
      .from('wedding_config')
      .select('total_budget, budget_shared')
      .eq('wedding_id', WEDDING_ID)
      .single()

    if (data) {
      setTotalBudget((data as Record<string, unknown>).total_budget as number || 0)
      setShareWithVenue((data as Record<string, unknown>).budget_shared as boolean || false)
    }
  }, [supabase])

  useEffect(() => {
    fetchItems()
    fetchBudgetConfig()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Computed ----
  // Total Budget = wedding_config.total_budget (user-set)
  // Budgeted = SUM of budget_items.budgeted (allocated to line items)
  // Committed = SUM of budget_items.committed
  // Paid = SUM of per-item paid (payments sum, fallback to .paid column)
  // Remaining = Total Budget - Committed
  const totals = useMemo(() => {
    const budgeted = items.reduce((s, i) => s + i.budgeted, 0)
    const committed = items.reduce((s, i) => s + i.committed, 0)
    const paid = items.reduce((s, i) => s + i.paid, 0)
    const remaining = totalBudget - committed
    const overBudget = committed > totalBudget && totalBudget > 0
    const underBudget = totalBudget > 0 && committed <= totalBudget
    return { budgeted, committed, paid, remaining, overBudget, underBudget }
  }, [items, totalBudget])

  // ---- Group by category ----
  const groupedItems = useMemo(() => {
    const groups: Record<string, BudgetItem[]> = {}
    for (const item of items) {
      const cat = item.category || 'Other'
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        if (
          !item.item_name.toLowerCase().includes(q) &&
          !cat.toLowerCase().includes(q)
        ) {
          continue
        }
      }
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(item)
    }
    // Sort: known categories first in their defined order, then any extras.
    const knownOrder = allCategories
      .filter((c) => groups[c] && groups[c].length > 0)
      .map((c) => ({ category: c, items: groups[c] }))
    const extras = Object.keys(groups)
      .filter((c) => !allCategories.includes(c))
      .sort()
      .map((c) => ({ category: c, items: groups[c] }))
    return [...knownOrder, ...extras]
  }, [items, allCategories, searchQuery])

  // ---- Toggle category expand ----
  function toggleCategory(cat: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  function togglePayments(itemId: string) {
    setExpandedPayments((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  // ---- Save total budget ----
  async function saveTotalBudget() {
    const amount = parseFloat(budgetInput.replace(/[^0-9.]/g, '')) || 0
    setTotalBudget(amount)
    setEditingBudget(false)
    await supabase
      .from('wedding_config')
      .upsert({ wedding_id: WEDDING_ID, total_budget: amount }, { onConflict: 'wedding_id' })
  }

  // ---- Share toggle ----
  async function toggleShare() {
    const val = !shareWithVenue
    setShareWithVenue(val)
    await supabase
      .from('wedding_config')
      .upsert({ wedding_id: WEDDING_ID, budget_shared: val }, { onConflict: 'wedding_id' })
  }

  // ---- Item modal ----
  function openAddItem(category?: string) {
    setForm({ ...EMPTY_FORM, category: category || '' })
    setEditingId(null)
    setShowItemModal(true)
  }

  function openEditItem(item: BudgetItem) {
    setForm({
      category: item.category,
      item_name: item.item_name,
      budgeted: item.budgeted.toString(),
      committed: item.committed.toString(),
      payment_source: item.payment_source || '',
      payment_due_date: item.payment_due_date || '',
      notes: item.notes || '',
    })
    setEditingId(item.id)
    setShowItemModal(true)
  }

  async function handleSaveItem() {
    if (!form.item_name.trim() || !form.category) return
    // Note: `is_custom_category` is tracked client-side via DEFAULT_CATEGORIES
    // membership; the DB schema (migration 017) has no such column, so we
    // must NOT include it in the insert payload or the write will fail.
    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      category: form.category,
      item_name: form.item_name.trim(),
      budgeted: parseFloat(form.budgeted) || 0,
      committed: parseFloat(form.committed) || 0,
      payment_source: form.payment_source || null,
      payment_due_date: form.payment_due_date || null,
      notes: form.notes.trim() || null,
      sort_order: editingId
        ? items.find((i) => i.id === editingId)?.sort_order || items.length + 1
        : items.length + 1,
    }

    if (editingId) {
      const { error } = await supabase
        .from('budget_items')
        .update(payload)
        .eq('id', editingId)
      if (error) {
        console.error('[budget] update failed:', error)
        alert('Failed to save item: ' + error.message)
        return
      }
    } else {
      const { error } = await supabase.from('budget_items').insert(payload)
      if (error) {
        console.error('[budget] insert failed:', error)
        alert('Failed to add item: ' + error.message)
        return
      }
    }

    setShowItemModal(false)
    setEditingId(null)
    fetchItems()
  }

  async function handleDeleteItem(id: string) {
    if (!confirm('Delete this budget item and all its payments?')) return
    await supabase.from('budget_payments').delete().eq('budget_item_id', id)
    await supabase.from('budget_items').delete().eq('id', id)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  // ---- Payment modal ----
  function openRecordPayment(itemId: string) {
    setPaymentItemId(itemId)
    setPaymentForm(EMPTY_PAYMENT)
    setShowPaymentModal(true)
  }

  async function handleSavePayment() {
    if (!paymentItemId || !paymentForm.amount) return
    const { error } = await supabase.from('budget_payments').insert({
      budget_item_id: paymentItemId,
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      amount: parseFloat(paymentForm.amount) || 0,
      payment_date: paymentForm.date || new Date().toISOString().split('T')[0],
      payment_method: paymentForm.method,
      notes: paymentForm.notes.trim() || null,
    })
    if (error) {
      console.error('[budget] payment insert failed:', error)
      alert('Failed to record payment: ' + error.message)
      return
    }
    setShowPaymentModal(false)
    setPaymentItemId(null)
    fetchItems()
  }

  async function handleDeletePayment(paymentId: string) {
    if (!confirm('Delete this payment record?')) return
    await supabase.from('budget_payments').delete().eq('id', paymentId)
    fetchItems()
  }

  // ---- Custom category ----
  function addCustomCategory() {
    const name = newCategoryName.trim()
    if (!name || allCategories.includes(name)) return
    setCustomCategories((prev) => [...prev, name])
    setNewCategoryName('')
  }

  // ---- Render ----
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Budget
          </h1>
          <p className="text-gray-500 text-sm">Track every dollar of your wedding budget.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCategoryModal(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <Plus className="w-4 h-4" />
            Category
          </button>
          <button
            onClick={() => openAddItem()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add Item
          </button>
        </div>
      </div>

      {/* Overall Dashboard */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
        {/* Total Budget */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Total Wedding Budget</p>
              {editingBudget ? (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-gray-400">$</span>
                  <input
                    type="text"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    className="text-xl font-bold w-32 border-b-2 bg-transparent focus:outline-none"
                    style={{ borderColor: 'var(--couple-primary)' }}
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && saveTotalBudget()}
                  />
                  <button
                    onClick={saveTotalBudget}
                    className="text-xs font-medium px-2 py-1 rounded text-white"
                    style={{ backgroundColor: 'var(--couple-primary)' }}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setBudgetInput(totalBudget.toString())
                    setEditingBudget(true)
                  }}
                  className="text-xl font-bold text-gray-900 hover:underline decoration-dotted"
                >
                  {totalBudget > 0 ? formatCurrency(totalBudget) : 'Set Budget'}
                </button>
              )}
            </div>
          </div>
          <button
            onClick={toggleShare}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
              shareWithVenue
                ? 'bg-green-50 border-green-200 text-green-700'
                : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
            )}
          >
            <Share2 className="w-3 h-3" />
            {shareWithVenue ? 'Shared with venue' : 'Share with venue'}
          </button>
        </div>

        {/* Committed vs Budget Progress */}
        {totalBudget > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1 text-xs">
              <span className="text-gray-500">
                Committed: {formatCurrency(totals.committed)} of {formatCurrency(totalBudget)}
              </span>
              <span
                className={cn(
                  'font-medium',
                  totals.overBudget ? 'text-red-600' : 'text-green-600'
                )}
              >
                {totals.overBudget
                  ? `${formatCurrency(totals.committed - totalBudget)} over`
                  : `${formatCurrency(totalBudget - totals.committed)} under`}
              </span>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  totals.overBudget ? 'bg-red-500' : ''
                )}
                style={{
                  width: `${Math.min((totals.committed / totalBudget) * 100, 100)}%`,
                  backgroundColor: totals.overBudget ? undefined : 'var(--couple-primary)',
                }}
              />
            </div>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-3 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
              <Receipt className="w-3.5 h-3.5" />
              Budgeted
            </div>
            <p className="text-lg font-bold text-gray-900">{formatCurrency(totals.budgeted)}</p>
          </div>
          <div className="p-3 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
              <CreditCard className="w-3.5 h-3.5" />
              Committed
            </div>
            <p className="text-lg font-bold text-gray-900">{formatCurrency(totals.committed)}</p>
          </div>
          <div className="p-3 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              Paid
            </div>
            <p className="text-lg font-bold text-green-700">{formatCurrency(totals.paid)}</p>
          </div>
          <div className="p-3 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
              <Banknote className="w-3.5 h-3.5 text-amber-500" />
              Remaining
            </div>
            <p className="text-lg font-bold text-amber-700">{formatCurrency(totals.remaining)}</p>
          </div>
        </div>

        {/* Over budget warning */}
        {totals.overBudget && (
          <div className="flex items-center gap-2 mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            You are {formatCurrency(totals.committed - totalBudget)} over your total budget.
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search items..."
          className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
        />
      </div>

      {/* Category Groups */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse h-20 bg-gray-100 rounded-xl" />
          ))}
        </div>
      ) : groupedItems.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <DollarSign className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {searchQuery ? 'No matching items' : 'No budget items yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {searchQuery ? 'Try a different search.' : 'Add your first budget item to start tracking.'}
          </p>
          {!searchQuery && (
            <button
              onClick={() => openAddItem()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add First Item
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {groupedItems.map(({ category, items: catItems }) => {
            const isExpanded = expandedCategories.has(category)
            const catBudgeted = catItems.reduce((s, i) => s + i.budgeted, 0)
            const catCommitted = catItems.reduce((s, i) => s + i.committed, 0)
            const catPaid = catItems.reduce((s, i) => s + i.paid, 0)
            const overCat = catBudgeted > 0 && catCommitted > catBudgeted
            const commitPct = catBudgeted > 0 ? Math.min((catCommitted / catBudgeted) * 100, 100) : 0

            return (
              <div key={category} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                {/* Category Header */}
                <button
                  onClick={() => toggleCategory(category)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                      style={{ backgroundColor: 'var(--couple-accent)' }}
                    >
                      {catItems.length}
                    </span>
                    <div className="text-left">
                      <h3 className="text-sm font-semibold text-gray-800">{category}</h3>
                      <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                        <span>Budget: {formatCurrency(catBudgeted)}</span>
                        <span>Committed: {formatCurrency(catCommitted)}</span>
                        <span>Paid: {formatCurrency(catPaid)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Progress mini bar */}
                    <div className="hidden sm:block w-24">
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={cn('h-full rounded-full', overCat ? 'bg-red-500' : '')}
                          style={{
                            width: `${commitPct}%`,
                            backgroundColor: overCat ? undefined : 'var(--couple-primary)',
                          }}
                        />
                      </div>
                    </div>
                    {overCat && (
                      <span className="text-xs text-red-600 font-medium flex items-center gap-0.5">
                        <TrendingUp className="w-3 h-3" />
                        Over
                      </span>
                    )}
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    )}
                  </div>
                </button>

                {/* Expanded Items */}
                {isExpanded && (
                  <div className="border-t border-gray-100">
                    {catItems.map((item) => {
                      const remaining = item.committed - item.paid
                      const dueInfo = formatDueDate(item.payment_due_date)
                      const paymentsOpen = expandedPayments.has(item.id)

                      return (
                        <div key={item.id} className="border-b border-gray-50 last:border-0">
                          <div className="px-5 py-3 flex items-center justify-between gap-3 group hover:bg-gray-50/50 transition-colors">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium text-gray-800">{item.item_name}</p>
                                {item.payment_source && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 rounded text-[10px] text-gray-600 font-medium">
                                    {SOURCE_ICONS[item.payment_source] || <MoreHorizontal className="w-3 h-3" />}
                                    {item.payment_source}
                                  </span>
                                )}
                                {dueInfo.text && (
                                  <span
                                    className={cn(
                                      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
                                      dueInfo.color
                                    )}
                                  >
                                    <Calendar className="w-2.5 h-2.5" />
                                    {dueInfo.text}
                                  </span>
                                )}
                              </div>
                              {item.notes && (
                                <p className="text-xs text-gray-400 mt-0.5 truncate">{item.notes}</p>
                              )}
                            </div>

                            {/* Dollar amounts */}
                            <div className="hidden sm:flex items-center gap-4 text-xs tabular-nums shrink-0">
                              <div className="text-center">
                                <p className="text-gray-400">Budgeted</p>
                                <p className="font-medium text-gray-700">{formatCurrency(item.budgeted)}</p>
                              </div>
                              <div className="text-center">
                                <p className="text-gray-400">Committed</p>
                                <p className={cn('font-medium', item.committed > item.budgeted && item.budgeted > 0 ? 'text-red-600' : 'text-gray-700')}>
                                  {formatCurrency(item.committed)}
                                </p>
                              </div>
                              <div className="text-center">
                                <p className="text-gray-400">Paid</p>
                                <p className="font-medium text-green-700">{formatCurrency(item.paid)}</p>
                              </div>
                              <div className="text-center">
                                <p className="text-gray-400">Remaining</p>
                                <p className="font-medium text-amber-700">{formatCurrency(remaining > 0 ? remaining : 0)}</p>
                              </div>
                            </div>

                            {/* Mobile amounts */}
                            <div className="sm:hidden text-right text-xs tabular-nums shrink-0">
                              <p className="font-medium text-gray-800">{formatCurrency(item.committed)}</p>
                              <p className="text-green-700">{formatCurrency(item.paid)} paid</p>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button
                                onClick={() => openRecordPayment(item.id)}
                                className="p-1.5 rounded-md text-gray-400 hover:text-green-600 hover:bg-green-50"
                                title="Record payment"
                              >
                                <DollarSign className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => togglePayments(item.id)}
                                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                                title="View payments"
                              >
                                <Receipt className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => openEditItem(item)}
                                className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteItem(item.id)}
                                className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Payment Records */}
                          {paymentsOpen && (
                            <div className="px-5 pb-3 ml-5">
                              <div className="bg-gray-50 rounded-lg p-3">
                                <p className="text-xs font-medium text-gray-500 mb-2">Payment History</p>
                                {item.payments && item.payments.length > 0 ? (
                                  <div className="space-y-1.5">
                                    {item.payments.map((p) => (
                                      <div key={p.id} className="flex items-center justify-between text-xs group/pay">
                                        <div className="flex items-center gap-3">
                                          <span className="text-gray-400">
                                            {p.payment_date
                                              ? new Date(p.payment_date + 'T00:00:00').toLocaleDateString('en-US', {
                                                  month: 'short',
                                                  day: 'numeric',
                                                  year: 'numeric',
                                                })
                                              : '—'}
                                          </span>
                                          <span className="font-medium text-gray-700">{formatCurrency(p.amount)}</span>
                                          <span className="px-1.5 py-0.5 bg-white rounded text-[10px] text-gray-500">
                                            {p.payment_method}
                                          </span>
                                          {p.notes && <span className="text-gray-400 truncate max-w-[120px]">{p.notes}</span>}
                                        </div>
                                        <button
                                          onClick={() => handleDeletePayment(p.id)}
                                          className="opacity-0 group-hover/pay:opacity-100 p-1 text-gray-400 hover:text-red-500"
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-xs text-gray-400">No payments recorded yet.</p>
                                )}
                                <button
                                  onClick={() => openRecordPayment(item.id)}
                                  className="mt-2 text-xs font-medium hover:underline"
                                  style={{ color: 'var(--couple-primary)' }}
                                >
                                  + Record Payment
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {/* Add item to this category */}
                    <button
                      onClick={() => openAddItem(category)}
                      className="w-full px-5 py-2.5 text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors flex items-center gap-2 border-t border-gray-100"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add item to {category}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add/Edit Item Modal */}
      {showItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowItemModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingId ? 'Edit Budget Item' : 'Add Budget Item'}
              </h2>
              <button onClick={() => setShowItemModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Item Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                <input
                  type="text"
                  value={form.item_name}
                  onChange={(e) => setForm({ ...form, item_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Jane Smith Photography"
                  autoFocus
                />
              </div>

              {/* Category */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  <option value="">Select category...</option>
                  {allCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {/* Budgeted + Committed */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Budgeted ($)</label>
                  <input
                    type="number"
                    value={form.budgeted}
                    onChange={(e) => setForm({ ...form, budgeted: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Committed ($)</label>
                  <input
                    type="number"
                    value={form.committed}
                    onChange={(e) => setForm({ ...form, committed: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="0"
                  />
                </div>
              </div>

              {/* Payment Source + Due Date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Payment Source</label>
                  <select
                    value={form.payment_source}
                    onChange={(e) => setForm({ ...form, payment_source: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    <option value="">Select...</option>
                    {PAYMENT_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Payment Due Date</label>
                  <input
                    type="date"
                    value={form.payment_due_date}
                    onChange={(e) => setForm({ ...form, payment_due_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Contract details, vendor notes..."
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowItemModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveItem}
                disabled={!form.item_name.trim() || !form.category}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Item'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Record Payment Modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowPaymentModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Record Payment
              </h2>
              <button onClick={() => setShowPaymentModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {paymentItemId && (
              <p className="text-sm text-gray-500">
                For: <span className="font-medium text-gray-700">{items.find((i) => i.id === paymentItemId)?.item_name}</span>
              </p>
            )}

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount ($)</label>
                  <input
                    type="number"
                    value={paymentForm.amount}
                    onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="0"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                  <input
                    type="date"
                    value={paymentForm.date}
                    onChange={(e) => setPaymentForm({ ...paymentForm, date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                <select
                  value={paymentForm.method}
                  onChange={(e) => setPaymentForm({ ...paymentForm, method: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input
                  type="text"
                  value={paymentForm.notes}
                  onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., deposit, final payment..."
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowPaymentModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSavePayment}
                disabled={!paymentForm.amount}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                Record Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Category Modal */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowCategoryModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Custom Categories
              </h2>
              <button onClick={() => setShowCategoryModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-gray-500">Default categories are always available. Add custom ones below.</p>

              {/* Existing custom categories */}
              {customCategories.length > 0 && (
                <div className="space-y-1.5">
                  {customCategories.map((cat) => (
                    <div key={cat} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                      <span className="text-sm text-gray-700">{cat}</span>
                      <button
                        onClick={() => setCustomCategories((prev) => prev.filter((c) => c !== cat))}
                        className="text-gray-400 hover:text-red-500"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add new */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Category name..."
                  onKeyDown={(e) => e.key === 'Enter' && addCustomCategory()}
                />
                <button
                  onClick={addCustomCategory}
                  disabled={!newCategoryName.trim()}
                  className="px-3 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--couple-primary)' }}
                >
                  Add
                </button>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowCategoryModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
