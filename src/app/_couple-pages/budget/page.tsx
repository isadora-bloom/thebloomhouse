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
  CreditCard,
  Receipt,
  Wallet,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
  PiggyBank,
  FileText,
  Calendar,
  Search,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BudgetItem {
  id: string
  category: string | null
  item_name: string
  estimated_cost: number | null
  actual_cost: number | null
  paid_amount: number | null
  notes: string | null
  vendor_name: string | null
  due_date: string | null
  is_paid: boolean
  contract_signed: boolean
}

interface BudgetFormData {
  category: string
  item_name: string
  estimated_cost: string
  actual_cost: string
  paid_amount: string
  notes: string
  vendor_name: string
  due_date: string
  is_paid: boolean
  contract_signed: boolean
}

interface PaymentRecord {
  id: string
  budget_item_id: string
  amount: number
  payment_date: string
  method: string | null
  notes: string | null
}

interface PaymentFormData {
  amount: string
  payment_date: string
  method: string
  notes: string
}

const DEFAULT_CATEGORIES = [
  'Venue',
  'Catering / Food',
  'Bar / Beverages',
  'Photography',
  'Videography',
  'Flowers',
  'Music / Entertainment',
  'Cake & Desserts',
  'Officiant',
  'Hair & Makeup',
  'Attire',
  'Decor / Rentals',
  'Stationery',
  'Transportation',
  'Tips',
  'Other',
]

const CATEGORY_ICONS: Record<string, string> = {
  'Venue': '🏛️',
  'Catering / Food': '🍽️',
  'Bar / Beverages': '🥂',
  'Photography': '📸',
  'Videography': '🎥',
  'Flowers': '💐',
  'Music / Entertainment': '🎵',
  'Cake & Desserts': '🎂',
  'Officiant': '💒',
  'Hair & Makeup': '💄',
  'Attire': '👔',
  'Decor / Rentals': '✨',
  'Stationery': '✉️',
  'Transportation': '🚗',
  'Tips': '💰',
  'Other': '📋',
}

const EMPTY_FORM: BudgetFormData = {
  category: '',
  item_name: '',
  estimated_cost: '',
  actual_cost: '',
  paid_amount: '',
  notes: '',
  vendor_name: '',
  due_date: '',
  is_paid: false,
  contract_signed: false,
}

const EMPTY_PAYMENT: PaymentFormData = {
  amount: '',
  payment_date: new Date().toISOString().split('T')[0],
  method: '',
  notes: '',
}

const PAYMENT_METHODS = ['Credit Card', 'Check', 'Bank Transfer', 'Cash', 'Venmo/Zelle', 'Other']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(value: number | null): string {
  if (value == null) return '$0'
  return `$${Math.round(value).toLocaleString()}`
}

function toNum(val: string): number | null {
  const n = parseFloat(val)
  return isNaN(n) ? null : n
}

function progressColor(percent: number): string {
  if (percent > 100) return '#EF4444'
  if (percent > 90) return '#F59E0B'
  return 'var(--couple-primary)'
}

// ---------------------------------------------------------------------------
// Budget Page
// ---------------------------------------------------------------------------

export default function BudgetPage() {
  const [items, setItems] = useState<BudgetItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [showBudgetSetter, setShowBudgetSetter] = useState(false)
  const [showAddCategory, setShowAddCategory] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<BudgetFormData>(EMPTY_FORM)
  const [paymentForm, setPaymentForm] = useState<PaymentFormData>(EMPTY_PAYMENT)
  const [paymentItemId, setPaymentItemId] = useState<string | null>(null)
  const [totalBudget, setTotalBudget] = useState(0)
  const [totalBudgetInput, setTotalBudgetInput] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [customCategories, setCustomCategories] = useState<string[]>([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterCategory, setFilterCategory] = useState<string | null>(null)

  const allCategories = [...DEFAULT_CATEGORIES, ...customCategories]
  const supabase = createClient()

  // ---- Fetch ----
  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from('budget')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('category', { ascending: true })
      .order('item_name', { ascending: true })

    if (!error && data) {
      setItems(data as BudgetItem[])
    }
    setLoading(false)
  }, [supabase])

  const fetchBudgetSettings = useCallback(async () => {
    const { data } = await supabase
      .from('wedding_settings')
      .select('total_budget, custom_budget_categories')
      .eq('wedding_id', WEDDING_ID)
      .single()

    if (data) {
      setTotalBudget(data.total_budget || 0)
      setCustomCategories(data.custom_budget_categories || [])
    }
  }, [supabase])

  useEffect(() => {
    fetchItems()
    fetchBudgetSettings()
  }, [fetchItems, fetchBudgetSettings])

  // ---- Computed totals ----
  const totals = useMemo(() => {
    const budgeted = items.reduce((s, i) => s + (Number(i.estimated_cost) || 0), 0)
    const committed = items.reduce((s, i) => s + (Number(i.actual_cost) || 0), 0)
    const paid = items.reduce((s, i) => s + (Number(i.paid_amount) || 0), 0)
    const outstanding = committed - paid
    const remaining = totalBudget > 0 ? totalBudget - committed : budgeted - committed

    return { budgeted, committed, paid, outstanding, remaining }
  }, [items, totalBudget])

  // ---- Category breakdown ----
  const categoryData = useMemo(() => {
    const cats: Record<string, {
      items: BudgetItem[]
      budgeted: number
      committed: number
      paid: number
    }> = {}

    items.forEach(item => {
      const cat = item.category || 'Uncategorized'
      if (!cats[cat]) cats[cat] = { items: [], budgeted: 0, committed: 0, paid: 0 }
      cats[cat].items.push(item)
      cats[cat].budgeted += Number(item.estimated_cost) || 0
      cats[cat].committed += Number(item.actual_cost) || 0
      cats[cat].paid += Number(item.paid_amount) || 0
    })

    return cats
  }, [items])

  // ---- Filter items ----
  const filteredCategoryEntries = useMemo(() => {
    let entries = Object.entries(categoryData)

    if (filterCategory) {
      entries = entries.filter(([cat]) => cat === filterCategory)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      entries = entries
        .map(([cat, data]) => [cat, {
          ...data,
          items: data.items.filter(i =>
            i.item_name.toLowerCase().includes(q) ||
            (i.vendor_name || '').toLowerCase().includes(q) ||
            (i.notes || '').toLowerCase().includes(q)
          ),
        }] as [string, typeof data])
        .filter(([, data]) => data.items.length > 0)
    }

    return entries.sort((a, b) => b[1].committed - a[1].committed)
  }, [categoryData, filterCategory, searchQuery])

  // ---- Toggle category ----
  function toggleCategory(cat: string) {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  // ---- Modal helpers ----
  function openAdd(category?: string) {
    setForm({ ...EMPTY_FORM, category: category || '' })
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(item: BudgetItem) {
    setForm({
      category: item.category || '',
      item_name: item.item_name,
      estimated_cost: item.estimated_cost?.toString() || '',
      actual_cost: item.actual_cost?.toString() || '',
      paid_amount: item.paid_amount?.toString() || '',
      notes: item.notes || '',
      vendor_name: item.vendor_name || '',
      due_date: item.due_date || '',
      is_paid: item.is_paid || false,
      contract_signed: item.contract_signed || false,
    })
    setEditingId(item.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.item_name.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      category: form.category || null,
      item_name: form.item_name.trim(),
      estimated_cost: toNum(form.estimated_cost),
      actual_cost: toNum(form.actual_cost),
      paid_amount: toNum(form.paid_amount),
      notes: form.notes.trim() || null,
      vendor_name: form.vendor_name.trim() || null,
      due_date: form.due_date || null,
      is_paid: form.is_paid,
      contract_signed: form.contract_signed,
    }

    if (editingId) {
      await supabase.from('budget').update(payload).eq('id', editingId)
    } else {
      await supabase.from('budget').insert(payload)
    }

    setShowModal(false)
    setEditingId(null)
    fetchItems()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this budget item?')) return
    await supabase.from('budget').delete().eq('id', id)
    fetchItems()
  }

  // ---- Payment tracking ----
  function openPayment(itemId: string) {
    setPaymentItemId(itemId)
    setPaymentForm(EMPTY_PAYMENT)
    setShowPaymentModal(true)
  }

  async function handleRecordPayment() {
    if (!paymentItemId || !paymentForm.amount) return

    const amount = parseFloat(paymentForm.amount)
    if (isNaN(amount)) return

    // Update the paid_amount on the budget item
    const item = items.find(i => i.id === paymentItemId)
    if (!item) return

    const newPaid = (Number(item.paid_amount) || 0) + amount
    const isFullyPaid = item.actual_cost ? newPaid >= Number(item.actual_cost) : false

    await supabase.from('budget').update({
      paid_amount: newPaid,
      is_paid: isFullyPaid,
    }).eq('id', paymentItemId)

    setShowPaymentModal(false)
    setPaymentItemId(null)
    fetchItems()
  }

  // ---- Budget setting ----
  async function saveTotalBudget() {
    const val = parseFloat(totalBudgetInput)
    if (isNaN(val)) return

    await supabase.from('wedding_settings').upsert({
      wedding_id: WEDDING_ID,
      total_budget: val,
    }, { onConflict: 'wedding_id' })

    setTotalBudget(val)
    setShowBudgetSetter(false)
  }

  // ---- Custom category ----
  async function addCustomCategory() {
    if (!newCategoryName.trim()) return
    const updated = [...customCategories, newCategoryName.trim()]
    await supabase.from('wedding_settings').upsert({
      wedding_id: WEDDING_ID,
      custom_budget_categories: updated,
    }, { onConflict: 'wedding_id' })
    setCustomCategories(updated)
    setNewCategoryName('')
    setShowAddCategory(false)
  }

  // ---- Progress calculations ----
  const overallBudgetBase = totalBudget > 0 ? totalBudget : totals.budgeted
  const overallCommittedPercent = overallBudgetBase > 0
    ? Math.round((totals.committed / overallBudgetBase) * 100)
    : 0
  const overallPaidPercent = overallBudgetBase > 0
    ? Math.round((totals.paid / overallBudgetBase) * 100)
    : 0
  const isOverBudget = totals.committed > overallBudgetBase && overallBudgetBase > 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Budget
          </h1>
          <p className="text-gray-500 text-sm">Track every dollar — budgeted, committed, and paid.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setTotalBudgetInput(totalBudget.toString()); setShowBudgetSetter(true) }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <PiggyBank className="w-3.5 h-3.5" />
            {totalBudget > 0 ? `Budget: ${fmt$(totalBudget)}` : 'Set Budget'}
          </button>
          <button
            onClick={() => openAdd()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add Item
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {totalBudget > 0 && (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 mb-1">
              <PiggyBank className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
              <span className="text-xs text-gray-500 font-medium">Total Budget</span>
            </div>
            <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {fmt$(totalBudget)}
            </p>
          </div>
        )}
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-4 h-4 text-blue-500" />
            <span className="text-xs text-gray-500 font-medium">Budgeted</span>
          </div>
          <p className="text-xl font-bold tabular-nums text-blue-600">{fmt$(totals.budgeted)}</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4 text-purple-500" />
            <span className="text-xs text-gray-500 font-medium">Committed</span>
          </div>
          <p className="text-xl font-bold tabular-nums text-purple-600">{fmt$(totals.committed)}</p>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-1">
            <CreditCard className="w-4 h-4 text-emerald-500" />
            <span className="text-xs text-gray-500 font-medium">Paid</span>
          </div>
          <p className="text-xl font-bold tabular-nums text-emerald-600">{fmt$(totals.paid)}</p>
        </div>
        <div className={cn('rounded-xl p-4 shadow-sm border', isOverBudget ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100')}>
          <div className="flex items-center gap-2 mb-1">
            {isOverBudget ? <AlertTriangle className="w-4 h-4 text-red-500" /> : <Wallet className="w-4 h-4 text-amber-500" />}
            <span className="text-xs text-gray-500 font-medium">{isOverBudget ? 'Over Budget' : 'Remaining'}</span>
          </div>
          <p className={cn('text-xl font-bold tabular-nums', isOverBudget ? 'text-red-600' : totals.remaining < 0 ? 'text-red-600' : 'text-amber-600')}>
            {isOverBudget ? fmt$(totals.committed - overallBudgetBase) : fmt$(Math.max(0, totals.remaining))}
          </p>
        </div>
      </div>

      {/* Overall Progress */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Overall Progress</span>
          {isOverBudget && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">
              <AlertTriangle className="w-3 h-3" />
              Over budget by {fmt$(totals.committed - overallBudgetBase)}
            </span>
          )}
        </div>

        {/* Committed bar */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">Committed</span>
            <span className="text-xs font-medium tabular-nums" style={{ color: progressColor(overallCommittedPercent) }}>
              {fmt$(totals.committed)} / {fmt$(overallBudgetBase)} ({overallCommittedPercent}%)
            </span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(100, overallCommittedPercent)}%`,
                backgroundColor: progressColor(overallCommittedPercent),
              }}
            />
          </div>
        </div>

        {/* Paid bar */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">Paid</span>
            <span className="text-xs font-medium tabular-nums text-emerald-600">
              {fmt$(totals.paid)} / {fmt$(totals.committed)} ({totals.committed > 0 ? Math.round((totals.paid / totals.committed) * 100) : 0}%)
            </span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all bg-emerald-500"
              style={{
                width: `${totals.committed > 0 ? Math.min(100, Math.round((totals.paid / totals.committed) * 100)) : 0}%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Search + Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search items, vendors..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:border-transparent"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>
        <select
          value={filterCategory || ''}
          onChange={e => setFilterCategory(e.target.value || null)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white text-gray-600"
        >
          <option value="">All categories</option>
          {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          onClick={() => setShowAddCategory(true)}
          className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium border border-gray-200 rounded-lg text-gray-500 hover:bg-gray-50"
        >
          <Plus className="w-3 h-3" />
          Category
        </button>
      </div>

      {/* Category Breakdown */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-16 bg-gray-100 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <DollarSign className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3 className="text-lg font-semibold mb-2" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
            No budget items yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Start tracking your wedding budget by adding items.</p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => { setTotalBudgetInput(''); setShowBudgetSetter(true) }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
            >
              <PiggyBank className="w-4 h-4" />
              Set Total Budget
            </button>
            <button
              onClick={() => openAdd()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add First Item
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredCategoryEntries.map(([cat, data]) => {
            const isExpanded = expandedCategories.has(cat)
            const catPercent = data.budgeted > 0 ? Math.round((data.committed / data.budgeted) * 100) : 0
            const paidPercent = data.committed > 0 ? Math.round((data.paid / data.committed) * 100) : 0
            const icon = CATEGORY_ICONS[cat] || '📋'

            return (
              <div key={cat} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                {/* Category header */}
                <button
                  onClick={() => toggleCategory(cat)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{icon}</span>
                    <div className="text-left">
                      <h3 className="font-semibold text-gray-800 text-sm">{cat}</h3>
                      <p className="text-xs text-gray-400">
                        {data.items.length} item{data.items.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right hidden sm:block">
                      <p className="text-sm font-semibold tabular-nums text-gray-800">{fmt$(data.committed)}</p>
                      <p className="text-[10px] text-gray-400">of {fmt$(data.budgeted)} budgeted</p>
                    </div>
                    <div className="w-20 hidden sm:block">
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.min(100, catPercent)}%`, backgroundColor: progressColor(catPercent) }}
                        />
                      </div>
                      <div className="h-1.5 bg-gray-50 rounded-full overflow-hidden mt-1">
                        <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.min(100, paidPercent)}%` }} />
                      </div>
                    </div>
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                  </div>
                </button>

                {/* Items */}
                {isExpanded && (
                  <div className="border-t border-gray-50">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-50 text-left">
                            <th className="px-5 py-2.5 font-medium text-gray-400 text-xs">Item</th>
                            <th className="px-3 py-2.5 font-medium text-gray-400 text-xs hidden md:table-cell">Vendor</th>
                            <th className="px-3 py-2.5 font-medium text-gray-400 text-xs text-right">Budgeted</th>
                            <th className="px-3 py-2.5 font-medium text-gray-400 text-xs text-right">Committed</th>
                            <th className="px-3 py-2.5 font-medium text-gray-400 text-xs text-right">Paid</th>
                            <th className="px-3 py-2.5 font-medium text-gray-400 text-xs text-right">Remaining</th>
                            <th className="px-3 py-2.5 font-medium text-gray-400 text-xs text-center hidden sm:table-cell">Status</th>
                            <th className="px-3 py-2.5 w-28" />
                          </tr>
                        </thead>
                        <tbody>
                          {data.items.map(item => {
                            const actual = Number(item.actual_cost) || 0
                            const paid = Number(item.paid_amount) || 0
                            const remaining = actual - paid
                            const overEstimate = item.estimated_cost && actual > Number(item.estimated_cost)

                            return (
                              <tr key={item.id} className="border-b border-gray-50 group hover:bg-gray-50/50">
                                <td className="px-5 py-3">
                                  <div>
                                    <p className="font-medium text-gray-800">{item.item_name}</p>
                                    {item.notes && <p className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[200px]">{item.notes}</p>}
                                    {item.due_date && (
                                      <span className="text-[10px] text-gray-400 flex items-center gap-0.5 mt-0.5">
                                        <Calendar className="w-2.5 h-2.5" />
                                        Due {new Date(item.due_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-3 py-3 text-gray-500 text-xs hidden md:table-cell">
                                  {item.vendor_name || <span className="text-gray-300">--</span>}
                                </td>
                                <td className="px-3 py-3 text-right tabular-nums text-gray-500">{fmt$(item.estimated_cost)}</td>
                                <td className={cn('px-3 py-3 text-right tabular-nums font-medium', overEstimate ? 'text-red-600' : 'text-gray-800')}>
                                  {fmt$(item.actual_cost)}
                                </td>
                                <td className="px-3 py-3 text-right tabular-nums text-emerald-600">{fmt$(item.paid_amount)}</td>
                                <td className="px-3 py-3 text-right tabular-nums">
                                  <span className={remaining > 0 ? 'text-amber-600' : 'text-gray-400'}>
                                    {remaining > 0 ? fmt$(remaining) : '$0'}
                                  </span>
                                </td>
                                <td className="px-3 py-3 text-center hidden sm:table-cell">
                                  <div className="flex items-center justify-center gap-1">
                                    {item.contract_signed && (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-purple-50 text-purple-600" title="Contract signed">
                                        CONTRACT
                                      </span>
                                    )}
                                    {item.is_paid ? (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-50 text-emerald-600">
                                        PAID
                                      </span>
                                    ) : actual > 0 && paid > 0 ? (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-50 text-amber-600">
                                        PARTIAL
                                      </span>
                                    ) : null}
                                  </div>
                                </td>
                                <td className="px-3 py-3">
                                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {!item.is_paid && actual > 0 && (
                                      <button
                                        onClick={() => openPayment(item.id)}
                                        className="p-1.5 rounded-md text-gray-400 hover:text-emerald-600 hover:bg-emerald-50"
                                        title="Record payment"
                                      >
                                        <CreditCard className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                    <button onClick={() => openEdit(item)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                                      <Edit2 className="w-3.5 h-3.5" />
                                    </button>
                                    <button onClick={() => handleDelete(item.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50">
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Add to category */}
                    <div className="px-5 py-3 border-t border-gray-50">
                      <button
                        onClick={() => openAdd(cat)}
                        className="inline-flex items-center gap-1 text-xs font-medium transition-colors"
                        style={{ color: 'var(--couple-primary)' }}
                      >
                        <Plus className="w-3 h-3" />
                        Add to {cat}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                {editingId ? 'Edit Budget Item' : 'Add Budget Item'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3">
              {/* Category */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}>
                  <option value="">Select category...</option>
                  {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              {/* Item + Vendor */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                  <input type="text" value={form.item_name} onChange={e => setForm({ ...form, item_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="e.g., Photographer" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Vendor</label>
                  <input type="text" value={form.vendor_name} onChange={e => setForm({ ...form, vendor_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="Vendor name" />
                </div>
              </div>

              {/* Amounts */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Budgeted</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input type="number" value={form.estimated_cost} onChange={e => setForm({ ...form, estimated_cost: e.target.value })}
                      className="w-full pl-7 pr-2 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="0" min={0} />
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">What you planned to spend</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Committed</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input type="number" value={form.actual_cost} onChange={e => setForm({ ...form, actual_cost: e.target.value })}
                      className="w-full pl-7 pr-2 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="0" min={0} />
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">Contract / quoted amount</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Paid</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                    <input type="number" value={form.paid_amount} onChange={e => setForm({ ...form, paid_amount: e.target.value })}
                      className="w-full pl-7 pr-2 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="0" min={0} />
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">Actually paid so far</p>
                </div>
              </div>

              {/* Due date */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1"><Calendar className="w-3.5 h-3.5 inline mr-1" />Due Date</label>
                  <input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
                </div>
                <div className="flex flex-col justify-end gap-2 pb-0.5">
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={form.contract_signed} onChange={e => setForm({ ...form, contract_signed: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300" style={{ accentColor: 'var(--couple-primary)' }} />
                    Contract signed
                  </label>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={form.is_paid} onChange={e => setForm({ ...form, is_paid: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300" style={{ accentColor: 'var(--couple-primary)' }} />
                    Fully paid
                  </label>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} rows={2} placeholder="Contract details, payment schedule..." />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={handleSave} disabled={!form.item_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}>
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
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                Record Payment
              </h2>
              <button onClick={() => setShowPaymentModal(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            {paymentItemId && (() => {
              const item = items.find(i => i.id === paymentItemId)
              if (!item) return null
              const remaining = (Number(item.actual_cost) || 0) - (Number(item.paid_amount) || 0)
              return (
                <div className="bg-gray-50 rounded-lg p-3 text-sm">
                  <p className="font-medium text-gray-800">{item.item_name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {fmt$(item.paid_amount)} paid of {fmt$(item.actual_cost)} · {fmt$(remaining)} remaining
                  </p>
                </div>
              )
            })()}

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                  <input type="number" value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                    className="w-full pl-7 pr-2 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="0" min={0} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                  <input type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm({ ...paymentForm, payment_date: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                  <select value={paymentForm.method} onChange={e => setPaymentForm({ ...paymentForm, method: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}>
                    <option value="">Select...</option>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input type="text" value={paymentForm.notes} onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="Deposit, final payment..." />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowPaymentModal(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={handleRecordPayment} disabled={!paymentForm.amount}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}>
                Record Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Set Budget Modal */}
      {showBudgetSetter && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowBudgetSetter(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
              Set Total Budget
            </h2>
            <p className="text-sm text-gray-500">Your overall wedding budget. Progress bars and remaining calculations will use this.</p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
              <input type="number" value={totalBudgetInput} onChange={e => setTotalBudgetInput(e.target.value)}
                className="w-full pl-7 pr-2 py-3 border border-gray-200 rounded-lg text-lg font-semibold focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="25000" min={0} autoFocus />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowBudgetSetter(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={saveTotalBudget}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: 'var(--couple-primary)' }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Category Modal */}
      {showAddCategory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowAddCategory(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
              Add Custom Category
            </h2>
            <input type="text" value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              placeholder="Category name" autoFocus onKeyDown={e => e.key === 'Enter' && addCustomCategory()} />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowAddCategory(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={addCustomCategory} disabled={!newCategoryName.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}>
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
