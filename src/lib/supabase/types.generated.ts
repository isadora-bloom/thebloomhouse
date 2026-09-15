export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      _archived_couple_budget: {
        Row: {
          categories: Json | null
          created_at: string | null
          id: string
          total_budget: number | null
          total_committed: number | null
          total_paid: number | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          categories?: Json | null
          created_at?: string | null
          id?: string
          total_budget?: number | null
          total_committed?: number | null
          total_paid?: number | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          categories?: Json | null
          created_at?: string | null
          id?: string
          total_budget?: number | null
          total_committed?: number | null
          total_paid?: number | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_budget_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_budget_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "couple_budget_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      _archived_follow_up_sequence_templates: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
          steps: Json | null
          trigger: string | null
          venue_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          steps?: Json | null
          trigger?: string | null
          venue_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          steps?: Json | null
          trigger?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_up_sequence_templates_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      _archived_seating_assignments: {
        Row: {
          created_at: string | null
          guest_id: string
          id: string
          seat_number: number | null
          table_id: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          created_at?: string | null
          guest_id: string
          id?: string
          seat_number?: number | null
          table_id: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          created_at?: string | null
          guest_id?: string
          id?: string
          seat_number?: number | null
          table_id?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seating_assignments_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seating_assignments_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "seating_tables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seating_assignments_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seating_assignments_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "seating_assignments_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      _archived_wedding_sequences: {
        Row: {
          completed_at: string | null
          created_at: string | null
          current_step: number | null
          enrolled_at: string | null
          id: string
          paused_at: string | null
          status: string | null
          template_id: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          current_step?: number | null
          enrolled_at?: string | null
          id?: string
          paused_at?: string | null
          status?: string | null
          template_id?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          current_step?: number | null
          enrolled_at?: string | null
          id?: string
          paused_at?: string | null
          status?: string | null
          template_id?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_sequences_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_sequences_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_sequences_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      _wave15_probe: {
        Row: {
          id: number
        }
        Insert: {
          id: number
        }
        Update: {
          id?: number
        }
        Relationships: []
      }
      accommodations: {
        Row: {
          address: string | null
          block_code: string | null
          block_deadline: string | null
          created_at: string | null
          description: string | null
          distance_miles: number | null
          id: string
          is_recommended: boolean | null
          name: string
          notes: string | null
          phone: string | null
          price_per_night: number | null
          price_range: string | null
          sort_order: number | null
          type: string | null
          venue_id: string
          website_url: string | null
        }
        Insert: {
          address?: string | null
          block_code?: string | null
          block_deadline?: string | null
          created_at?: string | null
          description?: string | null
          distance_miles?: number | null
          id?: string
          is_recommended?: boolean | null
          name: string
          notes?: string | null
          phone?: string | null
          price_per_night?: number | null
          price_range?: string | null
          sort_order?: number | null
          type?: string | null
          venue_id: string
          website_url?: string | null
        }
        Update: {
          address?: string | null
          block_code?: string | null
          block_deadline?: string | null
          created_at?: string | null
          description?: string | null
          distance_miles?: number | null
          id?: string
          is_recommended?: boolean | null
          name?: string
          notes?: string | null
          phone?: string | null
          price_per_night?: number | null
          price_range?: string | null
          sort_order?: number | null
          type?: string | null
          venue_id?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "accommodations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_log: {
        Row: {
          activity_type: string
          created_at: string | null
          details: Json | null
          entity_id: string | null
          entity_type: string | null
          id: string
          user_id: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          activity_type: string
          created_at?: string | null
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          activity_type?: string
          created_at?: string | null
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          user_id?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "activity_log_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_notifications: {
        Row: {
          body: string | null
          correlation_id: string | null
          created_at: string | null
          dedup_key: string | null
          email_sent: boolean | null
          id: string
          priority: string
          read: boolean | null
          read_at: string | null
          title: string
          type: string
          user_id: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          body?: string | null
          correlation_id?: string | null
          created_at?: string | null
          dedup_key?: string | null
          email_sent?: boolean | null
          id?: string
          priority?: string
          read?: boolean | null
          read_at?: string | null
          title: string
          type: string
          user_id?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          body?: string | null
          correlation_id?: string | null
          created_at?: string | null
          dedup_key?: string | null
          email_sent?: boolean | null
          id?: string
          priority?: string
          read?: boolean | null
          read_at?: string | null
          title?: string
          type?: string
          user_id?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_notifications_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_notifications_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "admin_notifications_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_activity_log: {
        Row: {
          agency_id: string
          body: string | null
          created_at: string
          deleted_at: string | null
          engagement_id: string | null
          id: string
          kind: string
          occurred_at: string
          payload: Json
          recorded_by: string | null
          summary: string
          venue_id: string | null
        }
        Insert: {
          agency_id: string
          body?: string | null
          created_at?: string
          deleted_at?: string | null
          engagement_id?: string | null
          id?: string
          kind?: string
          occurred_at?: string
          payload?: Json
          recorded_by?: string | null
          summary: string
          venue_id?: string | null
        }
        Update: {
          agency_id?: string
          body?: string | null
          created_at?: string
          deleted_at?: string | null
          engagement_id?: string | null
          id?: string
          kind?: string
          occurred_at?: string
          payload?: Json
          recorded_by?: string | null
          summary?: string
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agency_activity_log_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_activity_log_engagement_id_fkey"
            columns: ["engagement_id"]
            isOneToOne: false
            referencedRelation: "venue_agency_engagements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_activity_log_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_activity_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_contacts: {
        Row: {
          agency_id: string
          created_at: string
          deleted_at: string | null
          email: string | null
          id: string
          is_primary: boolean
          name: string
          notes: string | null
          phone: string | null
          role: string | null
          updated_at: string
        }
        Insert: {
          agency_id: string
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_primary?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          role?: string | null
          updated_at?: string
        }
        Update: {
          agency_id?: string
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          role?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_contacts_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_document_downloads: {
        Row: {
          agency_id: string
          document_id: string
          downloaded_at: string
          downloaded_by: string | null
          id: string
          ip_hash: string | null
          user_agent_hash: string | null
        }
        Insert: {
          agency_id: string
          document_id: string
          downloaded_at?: string
          downloaded_by?: string | null
          id?: string
          ip_hash?: string | null
          user_agent_hash?: string | null
        }
        Update: {
          agency_id?: string
          document_id?: string
          downloaded_at?: string
          downloaded_by?: string | null
          id?: string
          ip_hash?: string | null
          user_agent_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agency_document_downloads_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_document_downloads_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "agency_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_document_downloads_downloaded_by_fkey"
            columns: ["downloaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_documents: {
        Row: {
          agency_id: string
          created_at: string
          deleted_at: string | null
          effective_date: string | null
          engagement_id: string | null
          expires_at: string | null
          file_size_bytes: number | null
          file_url: string | null
          id: string
          kind: string | null
          mime_type: string | null
          name: string
          notes: string | null
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          agency_id: string
          created_at?: string
          deleted_at?: string | null
          effective_date?: string | null
          engagement_id?: string | null
          expires_at?: string | null
          file_size_bytes?: number | null
          file_url?: string | null
          id?: string
          kind?: string | null
          mime_type?: string | null
          name: string
          notes?: string | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          agency_id?: string
          created_at?: string
          deleted_at?: string | null
          effective_date?: string | null
          engagement_id?: string | null
          expires_at?: string | null
          file_size_bytes?: number | null
          file_url?: string | null
          id?: string
          kind?: string | null
          mime_type?: string | null
          name?: string
          notes?: string | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agency_documents_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_documents_engagement_id_fkey"
            columns: ["engagement_id"]
            isOneToOne: false
            referencedRelation: "venue_agency_engagements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      agency_kpi_commitments: {
        Row: {
          agency_id: string
          created_at: string
          deleted_at: string | null
          effective_from: string
          effective_to: string | null
          engagement_id: string | null
          id: string
          metric_name: string
          notes: string | null
          target_unit: string
          target_value: number
          target_window: string
          updated_at: string
        }
        Insert: {
          agency_id: string
          created_at?: string
          deleted_at?: string | null
          effective_from?: string
          effective_to?: string | null
          engagement_id?: string | null
          id?: string
          metric_name: string
          notes?: string | null
          target_unit?: string
          target_value: number
          target_window?: string
          updated_at?: string
        }
        Update: {
          agency_id?: string
          created_at?: string
          deleted_at?: string | null
          effective_from?: string
          effective_to?: string | null
          engagement_id?: string | null
          id?: string
          metric_name?: string
          notes?: string | null
          target_unit?: string
          target_value?: number
          target_window?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agency_kpi_commitments_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agency_kpi_commitments_engagement_id_fkey"
            columns: ["engagement_id"]
            isOneToOne: false
            referencedRelation: "venue_agency_engagements"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_couple_links: {
        Row: {
          agent_id: string
          couple_id: string
          established_at: string
          source: string
        }
        Insert: {
          agent_id: string
          couple_id: string
          established_at?: string
          source: string
        }
        Update: {
          agent_id?: string
          couple_id?: string
          established_at?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_couple_links_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_couple_links_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_briefings: {
        Row: {
          briefing_type: string
          content: Json
          created_at: string | null
          delivered_at: string | null
          delivered_via: string | null
          id: string
          venue_id: string
        }
        Insert: {
          briefing_type: string
          content?: Json
          created_at?: string | null
          delivered_at?: string | null
          delivered_via?: string | null
          id?: string
          venue_id: string
        }
        Update: {
          briefing_type?: string
          content?: Json
          created_at?: string | null
          delivered_at?: string | null
          delivered_via?: string | null
          id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_briefings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      allergy_registry: {
        Row: {
          allergy_type: string
          created_at: string | null
          guest_id: string | null
          guest_name: string
          id: string
          is_important: boolean | null
          notes: string | null
          severity: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          allergy_type: string
          created_at?: string | null
          guest_id?: string | null
          guest_name: string
          id?: string
          is_important?: boolean | null
          notes?: string | null
          severity?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          allergy_type?: string
          created_at?: string | null
          guest_id?: string | null
          guest_name?: string
          id?: string
          is_important?: boolean | null
          notes?: string | null
          severity?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "allergy_registry_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allergy_registry_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "allergy_registry_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "allergy_registry_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      alumni_cohorts: {
        Row: {
          archetype_description: string
          archetype_label: string
          booked_couple_count: number
          conversion_signature: Json
          cost_cents: number
          created_at: string
          id: string
          outcome_summary: Json
          persona_distribution: Json
          prompt_version: string
          refreshed_at: string
          venue_id: string
          voice_principles: Json
        }
        Insert: {
          archetype_description: string
          archetype_label: string
          booked_couple_count?: number
          conversion_signature?: Json
          cost_cents?: number
          created_at?: string
          id?: string
          outcome_summary?: Json
          persona_distribution?: Json
          prompt_version: string
          refreshed_at?: string
          venue_id: string
          voice_principles?: Json
        }
        Update: {
          archetype_description?: string
          archetype_label?: string
          booked_couple_count?: number
          conversion_signature?: Json
          cost_cents?: number
          created_at?: string
          id?: string
          outcome_summary?: Json
          persona_distribution?: Json
          prompt_version?: string
          refreshed_at?: string
          venue_id?: string
          voice_principles?: Json
        }
        Relationships: [
          {
            foreignKeyName: "alumni_cohorts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      annotations: {
        Row: {
          affects_metrics: string[] | null
          annotation_type: string | null
          anomaly_id: string | null
          created_at: string | null
          created_by: string | null
          description: string | null
          exclude_from_patterns: boolean | null
          id: string
          period_end: string | null
          period_start: string | null
          response_category: string | null
          title: string
          venue_id: string
        }
        Insert: {
          affects_metrics?: string[] | null
          annotation_type?: string | null
          anomaly_id?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          exclude_from_patterns?: boolean | null
          id?: string
          period_end?: string | null
          period_start?: string | null
          response_category?: string | null
          title: string
          venue_id: string
        }
        Update: {
          affects_metrics?: string[] | null
          annotation_type?: string | null
          anomaly_id?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          exclude_from_patterns?: boolean | null
          id?: string
          period_end?: string | null
          period_start?: string | null
          response_category?: string | null
          title?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "annotations_anomaly_id_fkey"
            columns: ["anomaly_id"]
            isOneToOne: false
            referencedRelation: "anomaly_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "annotations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "annotations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      anomaly_alerts: {
        Row: {
          acknowledged: boolean | null
          acknowledged_by: string | null
          ai_explanation: string | null
          alert_type: string
          baseline_value: number | null
          causes: Json | null
          change_percent: number | null
          created_at: string | null
          current_value: number | null
          explanation_source: string | null
          id: string
          metric_name: string
          severity: string
          venue_id: string
        }
        Insert: {
          acknowledged?: boolean | null
          acknowledged_by?: string | null
          ai_explanation?: string | null
          alert_type: string
          baseline_value?: number | null
          causes?: Json | null
          change_percent?: number | null
          created_at?: string | null
          current_value?: number | null
          explanation_source?: string | null
          id?: string
          metric_name: string
          severity: string
          venue_id: string
        }
        Update: {
          acknowledged?: boolean | null
          acknowledged_by?: string | null
          ai_explanation?: string | null
          alert_type?: string
          baseline_value?: number | null
          causes?: Json | null
          change_percent?: number | null
          created_at?: string | null
          current_value?: number | null
          explanation_source?: string | null
          id?: string
          metric_name?: string
          severity?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "anomaly_alerts_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anomaly_alerts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      api_costs: {
        Row: {
          content_tier: number | null
          context: string | null
          correlation_id: string | null
          cost: number | null
          created_at: string | null
          id: string
          input_tokens: number | null
          model: string | null
          output_tokens: number | null
          prompt_version: string | null
          service: string
          venue_id: string | null
        }
        Insert: {
          content_tier?: number | null
          context?: string | null
          correlation_id?: string | null
          cost?: number | null
          created_at?: string | null
          id?: string
          input_tokens?: number | null
          model?: string | null
          output_tokens?: number | null
          prompt_version?: string | null
          service: string
          venue_id?: string | null
        }
        Update: {
          content_tier?: number | null
          context?: string | null
          correlation_id?: string | null
          cost?: number | null
          created_at?: string | null
          id?: string
          input_tokens?: number | null
          model?: string | null
          output_tokens?: number | null
          prompt_version?: string | null
          service?: string
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "api_costs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      attribution_events: {
        Row: {
          bucket: string
          candidate_identity_id: string | null
          confidence: number
          conflict_resolution_state: string | null
          conflict_resolved_at: string | null
          conflict_resolved_by: string | null
          conflict_with_legacy_source: string | null
          created_at: string
          decided_at: string
          decided_by: string
          id: string
          intent_class: Database["public"]["Enums"]["attribution_intent_class"]
          intent_class_confidence_0_100: number | null
          intent_class_signals: Json | null
          intent_classified_at: string | null
          is_first_touch: boolean
          persona_overlay: Json | null
          prompt_version_classified_under: string | null
          reasoning: string | null
          referral_resolved_at: string | null
          referrer_confidence_0_100: number | null
          referrer_evidence_quote: string | null
          referrer_name_text: string | null
          referrer_relationship_text: string | null
          referrer_wedding_id: string | null
          reverted_at: string | null
          reverted_by: string | null
          reverted_reason: string | null
          role: Database["public"]["Enums"]["attribution_role"]
          role_classified_at: string | null
          role_confidence_0_100: number | null
          role_evidence: Json | null
          role_reasoning: string | null
          signal_class: string
          signal_id: string | null
          source_platform: string
          tier: string
          tombstoned_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          bucket: string
          candidate_identity_id?: string | null
          confidence: number
          conflict_resolution_state?: string | null
          conflict_resolved_at?: string | null
          conflict_resolved_by?: string | null
          conflict_with_legacy_source?: string | null
          created_at?: string
          decided_at?: string
          decided_by: string
          id?: string
          intent_class?: Database["public"]["Enums"]["attribution_intent_class"]
          intent_class_confidence_0_100?: number | null
          intent_class_signals?: Json | null
          intent_classified_at?: string | null
          is_first_touch?: boolean
          persona_overlay?: Json | null
          prompt_version_classified_under?: string | null
          reasoning?: string | null
          referral_resolved_at?: string | null
          referrer_confidence_0_100?: number | null
          referrer_evidence_quote?: string | null
          referrer_name_text?: string | null
          referrer_relationship_text?: string | null
          referrer_wedding_id?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          reverted_reason?: string | null
          role?: Database["public"]["Enums"]["attribution_role"]
          role_classified_at?: string | null
          role_confidence_0_100?: number | null
          role_evidence?: Json | null
          role_reasoning?: string | null
          signal_class: string
          signal_id?: string | null
          source_platform: string
          tier: string
          tombstoned_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          bucket?: string
          candidate_identity_id?: string | null
          confidence?: number
          conflict_resolution_state?: string | null
          conflict_resolved_at?: string | null
          conflict_resolved_by?: string | null
          conflict_with_legacy_source?: string | null
          created_at?: string
          decided_at?: string
          decided_by?: string
          id?: string
          intent_class?: Database["public"]["Enums"]["attribution_intent_class"]
          intent_class_confidence_0_100?: number | null
          intent_class_signals?: Json | null
          intent_classified_at?: string | null
          is_first_touch?: boolean
          persona_overlay?: Json | null
          prompt_version_classified_under?: string | null
          reasoning?: string | null
          referral_resolved_at?: string | null
          referrer_confidence_0_100?: number | null
          referrer_evidence_quote?: string | null
          referrer_name_text?: string | null
          referrer_relationship_text?: string | null
          referrer_wedding_id?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          reverted_reason?: string | null
          role?: Database["public"]["Enums"]["attribution_role"]
          role_classified_at?: string | null
          role_confidence_0_100?: number | null
          role_evidence?: Json | null
          role_reasoning?: string | null
          signal_class?: string
          signal_id?: string | null
          source_platform?: string
          tier?: string
          tombstoned_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attribution_events_candidate_identity_id_fkey"
            columns: ["candidate_identity_id"]
            isOneToOne: false
            referencedRelation: "candidate_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_referrer_wedding_id_fkey"
            columns: ["referrer_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "attribution_events_referrer_wedding_id_fkey"
            columns: ["referrer_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_reverted_by_fkey"
            columns: ["reverted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "tangential_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "attribution_events_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      attribution_intent_jobs: {
        Row: {
          attribution_event_id: string
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          attribution_event_id: string
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          attribution_event_id?: string
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attribution_intent_jobs_attribution_event_id_fkey"
            columns: ["attribution_event_id"]
            isOneToOne: false
            referencedRelation: "attribution_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_intent_jobs_attribution_event_id_fkey"
            columns: ["attribution_event_id"]
            isOneToOne: false
            referencedRelation: "attribution_events_live"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_intent_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      attribution_parity_log: {
        Row: {
          agree: boolean
          chain_source: string | null
          cluster_source: string | null
          computed_at: string
          detail: Json
          id: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          agree: boolean
          chain_source?: string | null
          cluster_source?: string | null
          computed_at?: string
          detail?: Json
          id?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          agree?: boolean
          chain_source?: string | null
          cluster_source?: string | null
          computed_at?: string
          detail?: Json
          id?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attribution_parity_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_parity_log_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "attribution_parity_log_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      attribution_role_jobs: {
        Row: {
          attribution_event_id: string
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          attribution_event_id: string
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          attribution_event_id?: string
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attribution_role_jobs_attribution_event_id_fkey"
            columns: ["attribution_event_id"]
            isOneToOne: false
            referencedRelation: "attribution_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_role_jobs_attribution_event_id_fkey"
            columns: ["attribution_event_id"]
            isOneToOne: false
            referencedRelation: "attribution_events_live"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_role_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      auto_send_rules: {
        Row: {
          channel: string
          confidence_threshold: number
          context: string
          daily_limit: number | null
          enabled: boolean | null
          graduated_at: string | null
          graduated_by: string | null
          id: string
          require_new_contact: boolean | null
          shadow_mode: boolean
          shadow_started_at: string | null
          source: string | null
          thread_cap_24h: number
          venue_id: string
        }
        Insert: {
          channel?: string
          confidence_threshold?: number
          context: string
          daily_limit?: number | null
          enabled?: boolean | null
          graduated_at?: string | null
          graduated_by?: string | null
          id?: string
          require_new_contact?: boolean | null
          shadow_mode?: boolean
          shadow_started_at?: string | null
          source?: string | null
          thread_cap_24h?: number
          venue_id: string
        }
        Update: {
          channel?: string
          confidence_threshold?: number
          context?: string
          daily_limit?: number | null
          enabled?: boolean | null
          graduated_at?: string | null
          graduated_by?: string | null
          id?: string
          require_new_contact?: boolean | null
          shadow_mode?: boolean
          shadow_started_at?: string | null
          source?: string | null
          thread_cap_24h?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "auto_send_rules_graduated_by_fkey"
            columns: ["graduated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auto_send_rules_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      auto_send_shadow_decisions: {
        Row: {
          confidence_score: number
          context_type: string
          created_at: string
          draft_id: string | null
          id: string
          injection_suspected: boolean
          reason: string
          review_note: string | null
          review_verdict: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          rule_id: string | null
          source: string | null
          thread_id: string | null
          venue_id: string
          wedding_id: string | null
          would_have_sent: boolean
        }
        Insert: {
          confidence_score: number
          context_type: string
          created_at?: string
          draft_id?: string | null
          id?: string
          injection_suspected?: boolean
          reason: string
          review_note?: string | null
          review_verdict?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          rule_id?: string | null
          source?: string | null
          thread_id?: string | null
          venue_id: string
          wedding_id?: string | null
          would_have_sent: boolean
        }
        Update: {
          confidence_score?: number
          context_type?: string
          created_at?: string
          draft_id?: string | null
          id?: string
          injection_suspected?: boolean
          reason?: string
          review_note?: string | null
          review_verdict?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          rule_id?: string | null
          source?: string | null
          thread_id?: string | null
          venue_id?: string
          wedding_id?: string | null
          would_have_sent?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "auto_send_shadow_decisions_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auto_send_shadow_decisions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auto_send_shadow_decisions_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "auto_send_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auto_send_shadow_decisions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "auto_send_shadow_decisions_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "auto_send_shadow_decisions_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      bar_planning: {
        Row: {
          bar_type: string | null
          bartender_count: number | null
          created_at: string | null
          guest_count: number | null
          id: string
          notes: string | null
          selected_package_id: string | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          bar_type?: string | null
          bartender_count?: number | null
          created_at?: string | null
          guest_count?: number | null
          id?: string
          notes?: string | null
          selected_package_id?: string | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          bar_type?: string | null
          bartender_count?: number | null
          created_at?: string | null
          guest_count?: number | null
          id?: string
          notes?: string | null
          selected_package_id?: string | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bar_planning_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bar_planning_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "bar_planning_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      bar_recipes: {
        Row: {
          cocktail_name: string
          created_at: string | null
          id: string
          ingredients: Json | null
          instructions: string | null
          scaling_factor: number | null
          servings: number | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          cocktail_name: string
          created_at?: string | null
          id?: string
          ingredients?: Json | null
          instructions?: string | null
          scaling_factor?: number | null
          servings?: number | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          cocktail_name?: string
          created_at?: string | null
          id?: string
          ingredients?: Json | null
          instructions?: string | null
          scaling_factor?: number | null
          servings?: number | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bar_recipes_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bar_recipes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "bar_recipes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      bar_shopping_list: {
        Row: {
          category: string | null
          created_at: string | null
          estimated_cost: number | null
          id: string
          item_name: string
          notes: string | null
          purchased: boolean | null
          quantity: number | null
          unit: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          estimated_cost?: number | null
          id?: string
          item_name: string
          notes?: string | null
          purchased?: boolean | null
          quantity?: number | null
          unit?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          category?: string | null
          created_at?: string | null
          estimated_cost?: number | null
          id?: string
          item_name?: string
          notes?: string | null
          purchased?: boolean | null
          quantity?: number | null
          unit?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bar_shopping_list_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bar_shopping_list_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "bar_shopping_list_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      bedroom_assignments: {
        Row: {
          created_at: string | null
          guests: string[] | null
          id: string
          notes: string | null
          room_description: string | null
          room_name: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          created_at?: string | null
          guests?: string[] | null
          id?: string
          notes?: string | null
          room_description?: string | null
          room_name: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          created_at?: string | null
          guests?: string[] | null
          id?: string
          notes?: string | null
          room_description?: string | null
          room_name?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bedroom_assignments_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bedroom_assignments_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "bedroom_assignments_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      booked_data_recovery_log: {
        Row: {
          attempted_at: string
          capability: string
          confidence: string | null
          duplicate_wedding_id: string | null
          error_message: string | null
          evidence: Json | null
          id: string
          outcome: string
          recovered_value_cents: number | null
          source_interaction_id: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          attempted_at?: string
          capability: string
          confidence?: string | null
          duplicate_wedding_id?: string | null
          error_message?: string | null
          evidence?: Json | null
          id?: string
          outcome: string
          recovered_value_cents?: number | null
          source_interaction_id?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          attempted_at?: string
          capability?: string
          confidence?: string | null
          duplicate_wedding_id?: string | null
          error_message?: string | null
          evidence?: Json | null
          id?: string
          outcome?: string
          recovered_value_cents?: number | null
          source_interaction_id?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "booked_data_recovery_log_duplicate_wedding_id_fkey"
            columns: ["duplicate_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "booked_data_recovery_log_duplicate_wedding_id_fkey"
            columns: ["duplicate_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booked_data_recovery_log_source_interaction_id_fkey"
            columns: ["source_interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booked_data_recovery_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booked_data_recovery_log_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "booked_data_recovery_log_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      booked_vendors: {
        Row: {
          arrival_time: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          contract_date: string | null
          contract_storage_path: string | null
          contract_uploaded: boolean | null
          contract_url: string | null
          created_at: string | null
          departure_time: string | null
          id: string
          instagram: string | null
          is_booked: boolean | null
          notes: string | null
          portal_token: string | null
          portal_token_expires_at: string | null
          portal_token_hash: string | null
          portal_token_issued_at: string | null
          updated_at: string | null
          vendor_contact: string | null
          vendor_name: string | null
          vendor_type: string
          venue_id: string
          website: string | null
          wedding_id: string
          worked_here_before: boolean | null
        }
        Insert: {
          arrival_time?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contract_date?: string | null
          contract_storage_path?: string | null
          contract_uploaded?: boolean | null
          contract_url?: string | null
          created_at?: string | null
          departure_time?: string | null
          id?: string
          instagram?: string | null
          is_booked?: boolean | null
          notes?: string | null
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_hash?: string | null
          portal_token_issued_at?: string | null
          updated_at?: string | null
          vendor_contact?: string | null
          vendor_name?: string | null
          vendor_type: string
          venue_id: string
          website?: string | null
          wedding_id: string
          worked_here_before?: boolean | null
        }
        Update: {
          arrival_time?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          contract_date?: string | null
          contract_storage_path?: string | null
          contract_uploaded?: boolean | null
          contract_url?: string | null
          created_at?: string | null
          departure_time?: string | null
          id?: string
          instagram?: string | null
          is_booked?: boolean | null
          notes?: string | null
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_hash?: string | null
          portal_token_issued_at?: string | null
          updated_at?: string | null
          vendor_contact?: string | null
          vendor_name?: string | null
          vendor_type?: string
          venue_id?: string
          website?: string | null
          wedding_id?: string
          worked_here_before?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "booked_vendors_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booked_vendors_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "booked_vendors_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      borrow_catalog: {
        Row: {
          category: string | null
          created_at: string | null
          description: string | null
          id: string
          image_url: string | null
          is_active: boolean | null
          item_name: string
          quantity_available: number | null
          venue_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          item_name: string
          quantity_available?: number | null
          venue_id: string
        }
        Update: {
          category?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          item_name?: string
          quantity_available?: number | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "borrow_catalog_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      borrow_selections: {
        Row: {
          catalog_item_id: string
          created_at: string | null
          id: string
          notes: string | null
          quantity: number | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          catalog_item_id: string
          created_at?: string | null
          id?: string
          notes?: string | null
          quantity?: number | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          catalog_item_id?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          quantity?: number | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "borrow_selections_catalog_item_id_fkey"
            columns: ["catalog_item_id"]
            isOneToOne: false
            referencedRelation: "borrow_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "borrow_selections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "borrow_selections_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "borrow_selections_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      brain_dump_entries: {
        Row: {
          clarification_answer: string | null
          clarification_question: string | null
          content_hash: string | null
          created_at: string
          id: string
          input_type: string
          parse_result: Json | null
          parse_status: string
          parsed_at: string | null
          pattern_signature: string | null
          raw_input: string
          resolved_at: string | null
          routed_to: Json
          submitted_by: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          clarification_answer?: string | null
          clarification_question?: string | null
          content_hash?: string | null
          created_at?: string
          id?: string
          input_type?: string
          parse_result?: Json | null
          parse_status?: string
          parsed_at?: string | null
          pattern_signature?: string | null
          raw_input: string
          resolved_at?: string | null
          routed_to?: Json
          submitted_by?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          clarification_answer?: string | null
          clarification_question?: string | null
          content_hash?: string | null
          created_at?: string
          id?: string
          input_type?: string
          parse_result?: Json | null
          parse_status?: string
          parsed_at?: string | null
          pattern_signature?: string | null
          raw_input?: string
          resolved_at?: string | null
          routed_to?: Json
          submitted_by?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brain_dump_entries_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brain_dump_entries_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      brain_dump_pattern_grants: {
        Row: {
          created_at: string
          description: string
          granted_at: string
          granted_by: string | null
          hit_count: number
          id: string
          intent: string
          is_active: boolean
          last_used_at: string | null
          pattern_signature: string
          revoked_at: string | null
          revoked_by: string | null
          routed_action: string | null
          routed_table: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          description: string
          granted_at?: string
          granted_by?: string | null
          hit_count?: number
          id?: string
          intent: string
          is_active?: boolean
          last_used_at?: string | null
          pattern_signature: string
          revoked_at?: string | null
          revoked_by?: string | null
          routed_action?: string | null
          routed_table?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          description?: string
          granted_at?: string
          granted_by?: string | null
          hit_count?: number
          id?: string
          intent?: string
          is_active?: boolean
          last_used_at?: string | null
          pattern_signature?: string
          revoked_at?: string | null
          revoked_by?: string | null
          routed_action?: string | null
          routed_table?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brain_dump_pattern_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brain_dump_pattern_grants_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brain_dump_pattern_grants_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      brand_assets: {
        Row: {
          asset_type: string
          caption: string | null
          category: string | null
          couple_category: string | null
          couple_facing: boolean
          created_at: string | null
          file_size_bytes: number | null
          id: string
          label: string | null
          mime_type: string | null
          sage_eligible: boolean
          sort_order: number | null
          url: string
          venue_id: string
        }
        Insert: {
          asset_type: string
          caption?: string | null
          category?: string | null
          couple_category?: string | null
          couple_facing?: boolean
          created_at?: string | null
          file_size_bytes?: number | null
          id?: string
          label?: string | null
          mime_type?: string | null
          sage_eligible?: boolean
          sort_order?: number | null
          url: string
          venue_id: string
        }
        Update: {
          asset_type?: string
          caption?: string | null
          category?: string | null
          couple_category?: string | null
          couple_facing?: boolean
          created_at?: string | null
          file_size_bytes?: number | null
          id?: string
          label?: string | null
          mime_type?: string | null
          sage_eligible?: boolean
          sort_order?: number | null
          url?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brand_assets_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      budget_items: {
        Row: {
          auto_extracted: boolean
          budgeted: number | null
          category: string
          committed: number | null
          created_at: string | null
          extraction_confirmed_at: string | null
          id: string
          item_name: string
          notes: string | null
          paid: number | null
          payment_due_date: string | null
          payment_source: string | null
          sort_order: number | null
          source_contract_id: string | null
          updated_at: string | null
          vendor_name: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          auto_extracted?: boolean
          budgeted?: number | null
          category: string
          committed?: number | null
          created_at?: string | null
          extraction_confirmed_at?: string | null
          id?: string
          item_name: string
          notes?: string | null
          paid?: number | null
          payment_due_date?: string | null
          payment_source?: string | null
          sort_order?: number | null
          source_contract_id?: string | null
          updated_at?: string | null
          vendor_name?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          auto_extracted?: boolean
          budgeted?: number | null
          category?: string
          committed?: number | null
          created_at?: string | null
          extraction_confirmed_at?: string | null
          id?: string
          item_name?: string
          notes?: string | null
          paid?: number | null
          payment_due_date?: string | null
          payment_source?: string | null
          sort_order?: number | null
          source_contract_id?: string | null
          updated_at?: string | null
          vendor_name?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "budget_items_source_contract_id_fkey"
            columns: ["source_contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_items_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_items_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "budget_items_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      budget_payments: {
        Row: {
          amount: number
          budget_item_id: string
          created_at: string | null
          id: string
          notes: string | null
          payment_date: string | null
          payment_method: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          amount: number
          budget_item_id: string
          created_at?: string | null
          id?: string
          notes?: string | null
          payment_date?: string | null
          payment_method?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          amount?: number
          budget_item_id?: string
          created_at?: string | null
          id?: string
          notes?: string | null
          payment_date?: string | null
          payment_method?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "budget_payments_budget_item_id_fkey"
            columns: ["budget_item_id"]
            isOneToOne: false
            referencedRelation: "budget_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_payments_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_payments_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "budget_payments_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          bookings_attributed: number | null
          channel: string | null
          cost_per_booking: number | null
          cost_per_inquiry: number | null
          created_at: string | null
          end_date: string | null
          id: string
          inquiries_attributed: number | null
          name: string
          notes: string | null
          revenue_attributed: number | null
          roi_ratio: number | null
          spend: number | null
          start_date: string | null
          tours_attributed: number | null
          venue_id: string
        }
        Insert: {
          bookings_attributed?: number | null
          channel?: string | null
          cost_per_booking?: number | null
          cost_per_inquiry?: number | null
          created_at?: string | null
          end_date?: string | null
          id?: string
          inquiries_attributed?: number | null
          name: string
          notes?: string | null
          revenue_attributed?: number | null
          roi_ratio?: number | null
          spend?: number | null
          start_date?: string | null
          tours_attributed?: number | null
          venue_id: string
        }
        Update: {
          bookings_attributed?: number | null
          channel?: string | null
          cost_per_booking?: number | null
          cost_per_inquiry?: number | null
          created_at?: string | null
          end_date?: string | null
          id?: string
          inquiries_attributed?: number | null
          name?: string
          notes?: string | null
          revenue_attributed?: number | null
          roi_ratio?: number | null
          spend?: number | null
          start_date?: string | null
          tours_attributed?: number | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_identities: {
        Row: {
          action_counts: Json
          backtrack_attempted_at: string | null
          city: string | null
          cluster_group_key: string | null
          country: string | null
          created_at: string
          deleted_at: string | null
          deleted_reason: string | null
          email: string | null
          first_name: string | null
          first_seen: string | null
          funnel_depth: number
          id: string
          last_initial: string | null
          last_name: string | null
          last_seen: string | null
          phone: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_confidence: number | null
          resolved_person_id: string | null
          resolved_wedding_id: string | null
          review_status: string
          same_as_candidate_id: string | null
          signal_count: number
          source_platform: string
          state: string | null
          updated_at: string
          username: string | null
          venue_id: string
        }
        Insert: {
          action_counts?: Json
          backtrack_attempted_at?: string | null
          city?: string | null
          cluster_group_key?: string | null
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_reason?: string | null
          email?: string | null
          first_name?: string | null
          first_seen?: string | null
          funnel_depth?: number
          id?: string
          last_initial?: string | null
          last_name?: string | null
          last_seen?: string | null
          phone?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_confidence?: number | null
          resolved_person_id?: string | null
          resolved_wedding_id?: string | null
          review_status?: string
          same_as_candidate_id?: string | null
          signal_count?: number
          source_platform: string
          state?: string | null
          updated_at?: string
          username?: string | null
          venue_id: string
        }
        Update: {
          action_counts?: Json
          backtrack_attempted_at?: string | null
          city?: string | null
          cluster_group_key?: string | null
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_reason?: string | null
          email?: string | null
          first_name?: string | null
          first_seen?: string | null
          funnel_depth?: number
          id?: string
          last_initial?: string | null
          last_name?: string | null
          last_seen?: string | null
          phone?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_confidence?: number | null
          resolved_person_id?: string | null
          resolved_wedding_id?: string | null
          review_status?: string
          same_as_candidate_id?: string | null
          signal_count?: number
          source_platform?: string
          state?: string | null
          updated_at?: string
          username?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_identities_resolved_person_id_fkey"
            columns: ["resolved_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_identities_resolved_wedding_id_fkey"
            columns: ["resolved_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "candidate_identities_resolved_wedding_id_fkey"
            columns: ["resolved_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_identities_same_as_candidate_id_fkey"
            columns: ["same_as_candidate_id"]
            isOneToOne: false
            referencedRelation: "candidate_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_identities_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_matches: {
        Row: {
          confidence_tier: string
          created_at: string
          id: string
          matcher_reason: string | null
          primary_record_id: string
          primary_record_type: string
          resolution: string | null
          resolved_at: string | null
          resolved_by_user_id: string | null
          secondary_record_id: string
          secondary_record_type: string
          venue_id: string
        }
        Insert: {
          confidence_tier: string
          created_at?: string
          id?: string
          matcher_reason?: string | null
          primary_record_id: string
          primary_record_type: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          secondary_record_id: string
          secondary_record_type: string
          venue_id: string
        }
        Update: {
          confidence_tier?: string
          created_at?: string
          id?: string
          matcher_reason?: string | null
          primary_record_id?: string
          primary_record_type?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          secondary_record_id?: string
          secondary_record_type?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_matches_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      ceremony_chair_plans: {
        Row: {
          created_at: string | null
          id: string
          plan: Json | null
          updated_at: string | null
          wedding_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          plan?: Json | null
          updated_at?: string | null
          wedding_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          plan?: Json | null
          updated_at?: string | null
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ceremony_chair_plans_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "ceremony_chair_plans_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      ceremony_order: {
        Row: {
          created_at: string | null
          id: string
          notes: string | null
          participant_name: string
          role: string | null
          section: string | null
          side: string | null
          sort_order: number | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          notes?: string | null
          participant_name: string
          role?: string | null
          section?: string | null
          side?: string | null
          sort_order?: number | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          notes?: string | null
          participant_name?: string
          role?: string | null
          section?: string | null
          side?: string | null
          sort_order?: number | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ceremony_order_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ceremony_order_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "ceremony_order_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_intel_snapshots: {
        Row: {
          channel_slug: string
          computed_at: string
          confidence_signals: Json
          cost_metrics: Json
          created_at: string
          funnel: Json
          id: string
          intent_breakdown: Json
          quality_metrics: Json
          role_breakdown: Json
          sample_sizes: Json
          source_platform: string
          venue_id: string
          window_days: number
        }
        Insert: {
          channel_slug: string
          computed_at?: string
          confidence_signals?: Json
          cost_metrics?: Json
          created_at?: string
          funnel?: Json
          id?: string
          intent_breakdown?: Json
          quality_metrics?: Json
          role_breakdown?: Json
          sample_sizes?: Json
          source_platform: string
          venue_id: string
          window_days: number
        }
        Update: {
          channel_slug?: string
          computed_at?: string
          confidence_signals?: Json
          cost_metrics?: Json
          created_at?: string
          funnel?: Json
          id?: string
          intent_breakdown?: Json
          quality_metrics?: Json
          role_breakdown?: Json
          sample_sizes?: Json
          source_platform?: string
          venue_id?: string
          window_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "channel_intel_snapshots_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_presentation_exports: {
        Row: {
          channel_slug: string
          created_at: string
          expires_at: string | null
          exported_at: string
          exported_by: string | null
          format: string
          id: string
          share_token: string
          snapshot_jsonb: Json
          venue_id: string
        }
        Insert: {
          channel_slug: string
          created_at?: string
          expires_at?: string | null
          exported_at?: string
          exported_by?: string | null
          format: string
          id?: string
          share_token: string
          snapshot_jsonb?: Json
          venue_id: string
        }
        Update: {
          channel_slug?: string
          created_at?: string
          expires_at?: string | null
          exported_at?: string
          exported_by?: string | null
          format?: string
          id?: string
          share_token?: string
          snapshot_jsonb?: Json
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_presentation_exports_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_truth_audits: {
        Row: {
          created_at: string
          id: string
          question_ids: string[]
          share_format: string | null
          shared_at: string | null
          shared_question_id: string | null
          snapshot_jsonb: Json
          venue_id: string
          viewed_at: string
          viewed_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          question_ids?: string[]
          share_format?: string | null
          shared_at?: string | null
          shared_question_id?: string | null
          snapshot_jsonb?: Json
          venue_id: string
          viewed_at?: string
          viewed_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          question_ids?: string[]
          share_format?: string | null
          shared_at?: string | null
          shared_question_id?: string | null
          snapshot_jsonb?: Json
          venue_id?: string
          viewed_at?: string
          viewed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "channel_truth_audits_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      checklist_items: {
        Row: {
          assigned_to: string | null
          category: string | null
          completed_at: string | null
          created_at: string | null
          description: string | null
          due_date: string | null
          id: string
          is_completed: boolean | null
          sort_order: number | null
          title: string
          vendor_type: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          assigned_to?: string | null
          category?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          is_completed?: boolean | null
          sort_order?: number | null
          title: string
          vendor_type?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          assigned_to?: string | null
          category?: string | null
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          is_completed?: boolean | null
          sort_order?: number | null
          title?: string
          vendor_type?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checklist_items_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checklist_items_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "checklist_items_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      client_codes: {
        Row: {
          code: string
          created_at: string | null
          format_template: string | null
          id: string
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          code: string
          created_at?: string | null
          format_template?: string | null
          id?: string
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          code?: string
          created_at?: string | null
          format_template?: string | null
          id?: string
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_codes_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_codes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "client_codes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      client_match_queue: {
        Row: {
          confidence: number | null
          created_at: string | null
          id: string
          match_type: string | null
          person_a_id: string | null
          person_b_id: string | null
          resolved_at: string | null
          resolved_by: string | null
          signal_a_id: string | null
          signal_b_id: string | null
          signals: Json
          status: string | null
          tier: string
          venue_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          id?: string
          match_type?: string | null
          person_a_id?: string | null
          person_b_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          signal_a_id?: string | null
          signal_b_id?: string | null
          signals?: Json
          status?: string | null
          tier?: string
          venue_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          id?: string
          match_type?: string | null
          person_a_id?: string | null
          person_b_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          signal_a_id?: string | null
          signal_b_id?: string | null
          signals?: Json
          status?: string | null
          tier?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_match_queue_person_a_fk"
            columns: ["person_a_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_match_queue_person_b_fk"
            columns: ["person_b_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_match_queue_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_match_queue_signal_a_id_fkey"
            columns: ["signal_a_id"]
            isOneToOne: false
            referencedRelation: "tangential_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_match_queue_signal_b_id_fkey"
            columns: ["signal_b_id"]
            isOneToOne: false
            referencedRelation: "tangential_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_match_queue_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      cohort_damping_cache: {
        Row: {
          booking_rate: number
          cap_tier: string | null
          cohort_booked: number
          cohort_signature: string
          cohort_size: number
          computed_at: string
          id: string
          multiplier: number
          venue_id: string
        }
        Insert: {
          booking_rate: number
          cap_tier?: string | null
          cohort_booked: number
          cohort_signature: string
          cohort_size: number
          computed_at?: string
          id?: string
          multiplier: number
          venue_id: string
        }
        Update: {
          booking_rate?: number
          cap_tier?: string | null
          cohort_booked?: number
          cohort_signature?: string
          cohort_size?: number
          computed_at?: string
          id?: string
          multiplier?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cohort_damping_cache_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      commitment_reconciliation: {
        Row: {
          commitment_key: string
          first_seen_at: string
          id: string
          judge_cache_key: string | null
          judge_reason: string | null
          kind: string
          last_checked_at: string
          matched_event_title: string | null
          quote: string
          resolved_at: string | null
          resolved_by: string | null
          source_interaction_id: string | null
          source_planning_note_id: string | null
          status: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          commitment_key: string
          first_seen_at?: string
          id?: string
          judge_cache_key?: string | null
          judge_reason?: string | null
          kind: string
          last_checked_at?: string
          matched_event_title?: string | null
          quote: string
          resolved_at?: string | null
          resolved_by?: string | null
          source_interaction_id?: string | null
          source_planning_note_id?: string | null
          status?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          commitment_key?: string
          first_seen_at?: string
          id?: string
          judge_cache_key?: string | null
          judge_reason?: string | null
          kind?: string
          last_checked_at?: string
          matched_event_title?: string | null
          quote?: string
          resolved_at?: string | null
          resolved_by?: string | null
          source_interaction_id?: string | null
          source_planning_note_id?: string | null
          status?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "commitment_reconciliation_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitment_reconciliation_source_interaction_id_fkey"
            columns: ["source_interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitment_reconciliation_source_planning_note_id_fkey"
            columns: ["source_planning_note_id"]
            isOneToOne: false
            referencedRelation: "planning_notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitment_reconciliation_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commitment_reconciliation_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "commitment_reconciliation_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      consultant_metrics: {
        Row: {
          avg_booking_value: number | null
          avg_response_time_minutes: number | null
          bookings_closed: number | null
          calculated_at: string | null
          consultant_id: string
          conversion_rate: number | null
          id: string
          inquiries_handled: number | null
          period_end: string
          period_start: string
          tours_booked: number | null
          venue_id: string
          visibility_config: Json
        }
        Insert: {
          avg_booking_value?: number | null
          avg_response_time_minutes?: number | null
          bookings_closed?: number | null
          calculated_at?: string | null
          consultant_id: string
          conversion_rate?: number | null
          id?: string
          inquiries_handled?: number | null
          period_end: string
          period_start: string
          tours_booked?: number | null
          venue_id: string
          visibility_config?: Json
        }
        Update: {
          avg_booking_value?: number | null
          avg_response_time_minutes?: number | null
          bookings_closed?: number | null
          calculated_at?: string | null
          consultant_id?: string
          conversion_rate?: number | null
          id?: string
          inquiries_handled?: number | null
          period_end?: string
          period_start?: string
          tours_booked?: number | null
          venue_id?: string
          visibility_config?: Json
        }
        Relationships: [
          {
            foreignKeyName: "consultant_metrics_consultant_id_fkey"
            columns: ["consultant_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consultant_metrics_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      consumer_requests: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          processed_at: string | null
          processed_by: string | null
          request_type: string
          requester_email: string
          requester_role: string
          requester_user_id: string | null
          resolution_notes: string | null
          scope: string
          status: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          id?: string
          processed_at?: string | null
          processed_by?: string | null
          request_type: string
          requester_email: string
          requester_role: string
          requester_user_id?: string | null
          resolution_notes?: string | null
          scope: string
          status?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          processed_at?: string | null
          processed_by?: string | null
          request_type?: string
          requester_email?: string
          requester_role?: string
          requester_user_id?: string | null
          resolution_notes?: string | null
          scope?: string
          status?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "consumer_requests_processed_by_fkey"
            columns: ["processed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumer_requests_requester_user_id_fkey"
            columns: ["requester_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumer_requests_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          created_at: string | null
          id: string
          is_primary: boolean | null
          person_id: string
          type: string
          value: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_primary?: boolean | null
          person_id: string
          type: string
          value: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_primary?: boolean | null
          person_id?: string
          type?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      contracts: {
        Row: {
          analysis: string | null
          analyzed_at: string | null
          created_at: string | null
          extracted_text: string | null
          file_type: string | null
          file_url: string | null
          filename: string
          generated_from: Json | null
          id: string
          key_terms: string[] | null
          kind: string
          sent_at: string | null
          sign_token: string | null
          signed_at: string | null
          signed_ip: string | null
          signed_name: string | null
          status: string | null
          storage_path: string | null
          template_key: string | null
          updated_at: string | null
          vendor_id: string | null
          vendor_name: string | null
          venue_id: string
          viewed_at: string | null
          wedding_id: string
        }
        Insert: {
          analysis?: string | null
          analyzed_at?: string | null
          created_at?: string | null
          extracted_text?: string | null
          file_type?: string | null
          file_url?: string | null
          filename: string
          generated_from?: Json | null
          id?: string
          key_terms?: string[] | null
          kind?: string
          sent_at?: string | null
          sign_token?: string | null
          signed_at?: string | null
          signed_ip?: string | null
          signed_name?: string | null
          status?: string | null
          storage_path?: string | null
          template_key?: string | null
          updated_at?: string | null
          vendor_id?: string | null
          vendor_name?: string | null
          venue_id: string
          viewed_at?: string | null
          wedding_id: string
        }
        Update: {
          analysis?: string | null
          analyzed_at?: string | null
          created_at?: string | null
          extracted_text?: string | null
          file_type?: string | null
          file_url?: string | null
          filename?: string
          generated_from?: Json | null
          id?: string
          key_terms?: string[] | null
          kind?: string
          sent_at?: string | null
          sign_token?: string | null
          signed_at?: string | null
          signed_ip?: string | null
          signed_name?: string | null
          status?: string | null
          storage_path?: string | null
          template_key?: string | null
          updated_at?: string | null
          vendor_id?: string | null
          vendor_name?: string | null
          venue_id?: string
          viewed_at?: string | null
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contracts_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "booked_vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "contracts_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      coordinator_absences: {
        Row: {
          assigned_consultant_id: string | null
          created_at: string
          deleted_at: string | null
          end_at: string
          handoff_notes: string | null
          id: string
          reason: string
          start_at: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          assigned_consultant_id?: string | null
          created_at?: string
          deleted_at?: string | null
          end_at: string
          handoff_notes?: string | null
          id?: string
          reason: string
          start_at: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          assigned_consultant_id?: string | null
          created_at?: string
          deleted_at?: string | null
          end_at?: string
          handoff_notes?: string | null
          id?: string
          reason?: string
          start_at?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coordinator_absences_assigned_consultant_id_fkey"
            columns: ["assigned_consultant_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coordinator_absences_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_identity_profile: {
        Row: {
          cost_cents: number
          created_at: string
          evidence_summary: Json
          identifiers: Json
          last_reconstructed_at: string
          last_signal_at: string | null
          locked_at: string | null
          locked_by_user_id: string | null
          partner1_locked_by_operator: boolean
          partner2_locked_by_operator: boolean
          profile: Json
          prompt_version: string
          reconstruction_count: number
          updated_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          cost_cents?: number
          created_at?: string
          evidence_summary?: Json
          identifiers?: Json
          last_reconstructed_at?: string
          last_signal_at?: string | null
          locked_at?: string | null
          locked_by_user_id?: string | null
          partner1_locked_by_operator?: boolean
          partner2_locked_by_operator?: boolean
          profile: Json
          prompt_version: string
          reconstruction_count?: number
          updated_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          cost_cents?: number
          created_at?: string
          evidence_summary?: Json
          identifiers?: Json
          last_reconstructed_at?: string
          last_signal_at?: string | null
          locked_at?: string | null
          locked_by_user_id?: string | null
          partner1_locked_by_operator?: boolean
          partner2_locked_by_operator?: boolean
          profile?: Json
          prompt_version?: string
          reconstruction_count?: number
          updated_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_identity_profile_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_identity_profile_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "couple_identity_profile_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_intel: {
        Row: {
          cost_cents: number
          created_at: string
          derive_count: number
          intel: Json
          last_derived_at: string
          persona_label: string | null
          predicted_close_probability_pct: number | null
          prompt_version: string
          source_profile_at: string | null
          updated_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          cost_cents?: number
          created_at?: string
          derive_count?: number
          intel: Json
          last_derived_at?: string
          persona_label?: string | null
          predicted_close_probability_pct?: number | null
          prompt_version: string
          source_profile_at?: string | null
          updated_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          cost_cents?: number
          created_at?: string
          derive_count?: number
          intel?: Json
          last_derived_at?: string
          persona_label?: string | null
          predicted_close_probability_pct?: number | null
          prompt_version?: string
          source_profile_at?: string | null
          updated_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_intel_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_intel_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "couple_intel_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_intel_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_intel_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_intel_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "couple_intel_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_invites: {
        Row: {
          created_at: string
          created_by: string | null
          email: string
          expires_at: string
          id: string
          token_hash: string
          used_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          email: string
          expires_at?: string
          id?: string
          token_hash: string
          used_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          email?: string
          expires_at?: string
          id?: string
          token_hash?: string
          used_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_invites_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_invites_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "couple_invites_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_merge_events: {
        Row: {
          confidence_tier: string | null
          event_type: string
          id: string
          occurred_at: string
          operator_id: string | null
          primary_couple_id: string | null
          reason: string | null
          rule_triggered: string | null
          secondary_couple_id: string | null
          venue_id: string
        }
        Insert: {
          confidence_tier?: string | null
          event_type: string
          id?: string
          occurred_at?: string
          operator_id?: string | null
          primary_couple_id?: string | null
          reason?: string | null
          rule_triggered?: string | null
          secondary_couple_id?: string | null
          venue_id: string
        }
        Update: {
          confidence_tier?: string | null
          event_type?: string
          id?: string
          occurred_at?: string
          operator_id?: string | null
          primary_couple_id?: string | null
          reason?: string | null
          rule_triggered?: string | null
          secondary_couple_id?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_merge_events_primary_couple_id_fkey"
            columns: ["primary_couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_merge_events_secondary_couple_id_fkey"
            columns: ["secondary_couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_merge_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_notifications: {
        Row: {
          body: string | null
          created_at: string | null
          id: string
          link: string | null
          read: boolean | null
          title: string
          type: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string | null
          id?: string
          link?: string | null
          read?: boolean | null
          title: string
          type: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          body?: string | null
          created_at?: string | null
          id?: string
          link?: string | null
          read?: boolean | null
          title?: string
          type?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "couple_notifications_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_notifications_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "couple_notifications_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      couple_progression_events: {
        Row: {
          couple_id: string
          event_type: string
          occurred_at: string
          source_touchpoint_id: string | null
        }
        Insert: {
          couple_id: string
          event_type: string
          occurred_at: string
          source_touchpoint_id?: string | null
        }
        Update: {
          couple_id?: string
          event_type?: string
          occurred_at?: string
          source_touchpoint_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "couple_progression_events_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couple_progression_events_source_touchpoint_id_fkey"
            columns: ["source_touchpoint_id"]
            isOneToOne: false
            referencedRelation: "touchpoints"
            referencedColumns: ["id"]
          },
        ]
      }
      couples: {
        Row: {
          channel_scope: string | null
          created_at: string
          decay_window_days: number
          first_seen_at: string | null
          handles: Json
          heat_score: number | null
          id: string
          last_progression_at: string | null
          lifecycle_state: string
          merged_into_id: string | null
          partner_contact_email: string | null
          partner_contact_name: string | null
          partner_contact_phone: string | null
          point_zero_at: string | null
          point_zero_touchpoint_id: string | null
          primary_contact_email: string | null
          primary_contact_name: string
          primary_contact_phone: string | null
          source_wedding_id: string | null
          updated_at: string
          venue_id: string
          wedding_date: string | null
        }
        Insert: {
          channel_scope?: string | null
          created_at?: string
          decay_window_days?: number
          first_seen_at?: string | null
          handles?: Json
          heat_score?: number | null
          id?: string
          last_progression_at?: string | null
          lifecycle_state: string
          merged_into_id?: string | null
          partner_contact_email?: string | null
          partner_contact_name?: string | null
          partner_contact_phone?: string | null
          point_zero_at?: string | null
          point_zero_touchpoint_id?: string | null
          primary_contact_email?: string | null
          primary_contact_name: string
          primary_contact_phone?: string | null
          source_wedding_id?: string | null
          updated_at?: string
          venue_id: string
          wedding_date?: string | null
        }
        Update: {
          channel_scope?: string | null
          created_at?: string
          decay_window_days?: number
          first_seen_at?: string | null
          handles?: Json
          heat_score?: number | null
          id?: string
          last_progression_at?: string | null
          lifecycle_state?: string
          merged_into_id?: string | null
          partner_contact_email?: string | null
          partner_contact_name?: string | null
          partner_contact_phone?: string | null
          point_zero_at?: string | null
          point_zero_touchpoint_id?: string | null
          primary_contact_email?: string | null
          primary_contact_name?: string
          primary_contact_phone?: string | null
          source_wedding_id?: string | null
          updated_at?: string
          venue_id?: string
          wedding_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "couples_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couples_point_zero_touchpoint_id_fkey"
            columns: ["point_zero_touchpoint_id"]
            isOneToOne: false
            referencedRelation: "touchpoints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couples_source_wedding_id_fkey"
            columns: ["source_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "couples_source_wedding_id_fkey"
            columns: ["source_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "couples_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_import_rows: {
        Row: {
          content_hash: string
          first_seen_at: string
          id: string
          last_seen_at: string
          resolution: string
          resolution_reason: string | null
          resolved_at: string | null
          resolved_by_user_id: string | null
          resolved_wedding_id: string | null
          row_data: Json
          row_fingerprint: string
          source: string
          state_history: Json
          venue_id: string
        }
        Insert: {
          content_hash: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          resolution?: string
          resolution_reason?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          resolved_wedding_id?: string | null
          row_data?: Json
          row_fingerprint: string
          source: string
          state_history?: Json
          venue_id: string
        }
        Update: {
          content_hash?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          resolution?: string
          resolution_reason?: string | null
          resolved_at?: string | null
          resolved_by_user_id?: string | null
          resolved_wedding_id?: string | null
          row_data?: Json
          row_fingerprint?: string
          source?: string
          state_history?: Json
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_import_rows_resolved_wedding_id_fkey"
            columns: ["resolved_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "crm_import_rows_resolved_wedding_id_fkey"
            columns: ["resolved_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_import_rows_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_runs: {
        Row: {
          cron_name: string
          duration_ms: number | null
          ended_at: string | null
          error_class: string | null
          error_message: string | null
          id: string
          metadata: Json
          rows_processed: number | null
          started_at: string
          status: string
          venue_id: string | null
        }
        Insert: {
          cron_name: string
          duration_ms?: number | null
          ended_at?: string | null
          error_class?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json
          rows_processed?: number | null
          started_at?: string
          status?: string
          venue_id?: string | null
        }
        Update: {
          cron_name?: string
          duration_ms?: number | null
          ended_at?: string | null
          error_class?: string | null
          error_message?: string | null
          id?: string
          metadata?: Json
          rows_processed?: number | null
          started_at?: string
          status?: string
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cron_runs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      cross_venue_overlap: {
        Row: {
          anchor_venue_id: string
          computed_at: string
          confidence_0_100: number
          id: string
          overlap_jsonb: Json
          peer_venue_id: string
        }
        Insert: {
          anchor_venue_id: string
          computed_at?: string
          confidence_0_100: number
          id?: string
          overlap_jsonb: Json
          peer_venue_id: string
        }
        Update: {
          anchor_venue_id?: string
          computed_at?: string
          confidence_0_100?: number
          id?: string
          overlap_jsonb?: Json
          peer_venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cross_venue_overlap_anchor_venue_id_fkey"
            columns: ["anchor_venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cross_venue_overlap_peer_venue_id_fkey"
            columns: ["peer_venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      cultural_moments: {
        Row: {
          archive_reason: string | null
          category: string | null
          created_at: string
          description: string | null
          end_at: string | null
          evidence: Json
          geo_scope: string | null
          id: string
          influence_weight: number | null
          proposed_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          start_at: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          archive_reason?: string | null
          category?: string | null
          created_at?: string
          description?: string | null
          end_at?: string | null
          evidence?: Json
          geo_scope?: string | null
          id?: string
          influence_weight?: number | null
          proposed_by?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          start_at: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          archive_reason?: string | null
          category?: string | null
          created_at?: string
          description?: string | null
          end_at?: string | null
          evidence?: Json
          geo_scope?: string | null
          id?: string
          influence_weight?: number | null
          proposed_by?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          start_at?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cultural_moments_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      day_of_media: {
        Row: {
          caption: string | null
          category: string
          created_at: string | null
          filename: string | null
          id: string
          mime_type: string | null
          size_bytes: number | null
          sort_order: number | null
          storage_path: string | null
          uploaded_by: string | null
          url: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          caption?: string | null
          category: string
          created_at?: string | null
          filename?: string | null
          id?: string
          mime_type?: string | null
          size_bytes?: number | null
          sort_order?: number | null
          storage_path?: string | null
          uploaded_by?: string | null
          url: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          caption?: string | null
          category?: string
          created_at?: string | null
          filename?: string | null
          id?: string
          mime_type?: string | null
          size_bytes?: number | null
          sort_order?: number | null
          storage_path?: string | null
          uploaded_by?: string | null
          url?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "day_of_media_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "day_of_media_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "day_of_media_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "day_of_media_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      decor_inventory: {
        Row: {
          category: string | null
          created_at: string | null
          id: string
          image_url: string | null
          item_name: string
          leaving_instructions: string | null
          notes: string | null
          quantity: number | null
          source: string | null
          vendor_name: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          id?: string
          image_url?: string | null
          item_name: string
          leaving_instructions?: string | null
          notes?: string | null
          quantity?: number | null
          source?: string | null
          vendor_name?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          category?: string | null
          created_at?: string | null
          id?: string
          image_url?: string | null
          item_name?: string
          leaving_instructions?: string | null
          notes?: string | null
          quantity?: number | null
          source?: string | null
          vendor_name?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "decor_inventory_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decor_inventory_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "decor_inventory_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      digest_preferences: {
        Row: {
          cadence: string
          channel_email: boolean
          channel_in_app: boolean
          created_at: string
          id: string
          include_anomalies: boolean
          include_lead_conversion: boolean
          include_macro_correlations: boolean
          include_pricing: boolean
          include_self_knowledge: boolean
          include_source_attribution: boolean
          last_sent_at: string | null
          send_dow: number
          send_time_local: string
          updated_at: string
          user_id: string
          venue_id: string
        }
        Insert: {
          cadence?: string
          channel_email?: boolean
          channel_in_app?: boolean
          created_at?: string
          id?: string
          include_anomalies?: boolean
          include_lead_conversion?: boolean
          include_macro_correlations?: boolean
          include_pricing?: boolean
          include_self_knowledge?: boolean
          include_source_attribution?: boolean
          last_sent_at?: string | null
          send_dow?: number
          send_time_local?: string
          updated_at?: string
          user_id: string
          venue_id: string
        }
        Update: {
          cadence?: string
          channel_email?: boolean
          channel_in_app?: boolean
          created_at?: string
          id?: string
          include_anomalies?: boolean
          include_lead_conversion?: boolean
          include_macro_correlations?: boolean
          include_pricing?: boolean
          include_self_knowledge?: boolean
          include_source_attribution?: boolean
          last_sent_at?: string | null
          send_dow?: number
          send_time_local?: string
          updated_at?: string
          user_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "digest_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "digest_preferences_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      disagreement_findings: {
        Row: {
          axis: string
          confidence_0_100: number | null
          created_at: string
          dismissed_at: string | null
          dismissed_by: string | null
          first_detected_at: string
          forensic_source_kind: string | null
          forensic_value: Json | null
          id: string
          last_observed_at: string
          magnitude_score: number | null
          narrator_cost_cents: number | null
          narrator_generated_at: string | null
          narrator_prompt_version: string | null
          narrator_text: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          stated_source_kind: string | null
          stated_value: Json | null
          status: string
          updated_at: string
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          axis: string
          confidence_0_100?: number | null
          created_at?: string
          dismissed_at?: string | null
          dismissed_by?: string | null
          first_detected_at?: string
          forensic_source_kind?: string | null
          forensic_value?: Json | null
          id?: string
          last_observed_at?: string
          magnitude_score?: number | null
          narrator_cost_cents?: number | null
          narrator_generated_at?: string | null
          narrator_prompt_version?: string | null
          narrator_text?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          stated_source_kind?: string | null
          stated_value?: Json | null
          status?: string
          updated_at?: string
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          axis?: string
          confidence_0_100?: number | null
          created_at?: string
          dismissed_at?: string | null
          dismissed_by?: string | null
          first_detected_at?: string
          forensic_source_kind?: string | null
          forensic_value?: Json | null
          id?: string
          last_observed_at?: string
          magnitude_score?: number | null
          narrator_cost_cents?: number | null
          narrator_generated_at?: string | null
          narrator_prompt_version?: string | null
          narrator_text?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          stated_source_kind?: string | null
          stated_value?: Json | null
          status?: string
          updated_at?: string
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "df_venue_fk"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "df_wedding_fk"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "df_wedding_fk"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      disagreement_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "disagreement_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disagreement_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "disagreement_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      discovery_digests: {
        Row: {
          cost_cents: number
          created_at: string
          delivered_at: string | null
          delivered_via: string | null
          digest_jsonb: Json
          digest_period_end: string
          digest_period_start: string
          generated_at: string
          id: string
          prompt_version: string
          venue_id: string
        }
        Insert: {
          cost_cents?: number
          created_at?: string
          delivered_at?: string | null
          delivered_via?: string | null
          digest_jsonb: Json
          digest_period_end: string
          digest_period_start: string
          generated_at?: string
          id?: string
          prompt_version: string
          venue_id: string
        }
        Update: {
          cost_cents?: number
          created_at?: string
          delivered_at?: string | null
          delivered_via?: string | null
          digest_jsonb?: Json
          digest_period_end?: string
          digest_period_start?: string
          generated_at?: string
          id?: string
          prompt_version?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discovery_digests_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      discovery_feedback_actions: {
        Row: {
          action_type: string
          discovery_id: string
          error: string | null
          id: string
          payload: Json | null
          target_system: string
          venue_id: string
          written_at: string
        }
        Insert: {
          action_type: string
          discovery_id: string
          error?: string | null
          id?: string
          payload?: Json | null
          target_system: string
          venue_id: string
          written_at?: string
        }
        Update: {
          action_type?: string
          discovery_id?: string
          error?: string | null
          id?: string
          payload?: Json | null
          target_system?: string
          venue_id?: string
          written_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discovery_feedback_actions_discovery_id_fkey"
            columns: ["discovery_id"]
            isOneToOne: false
            referencedRelation: "intel_discoveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_feedback_actions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      discovery_sources: {
        Row: {
          answer_text: string
          canonical_source: string
          capture_ref: string | null
          capture_source: string
          captured_at: string
          id: string
          person_id: string | null
          question_text: string | null
          referrer_name: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          answer_text: string
          canonical_source: string
          capture_ref?: string | null
          capture_source: string
          captured_at?: string
          id?: string
          person_id?: string | null
          question_text?: string | null
          referrer_name?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          answer_text?: string
          canonical_source?: string
          capture_ref?: string | null
          capture_source?: string
          captured_at?: string
          id?: string
          person_id?: string | null
          question_text?: string | null
          referrer_name?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "discovery_sources_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_sources_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_sources_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "discovery_sources_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_edit_insights: {
        Row: {
          confidence_0_100: number
          created_at: string
          draft_id: string
          id: string
          insight_kind: string
          learning_summary: string
          operator_acknowledged_at: string | null
          operator_correction: string | null
          operator_text: string | null
          operator_visible: boolean
          persisted_ref: string | null
          persisted_to: string
          sage_text: string | null
          venue_id: string
        }
        Insert: {
          confidence_0_100?: number
          created_at?: string
          draft_id: string
          id?: string
          insight_kind: string
          learning_summary: string
          operator_acknowledged_at?: string | null
          operator_correction?: string | null
          operator_text?: string | null
          operator_visible?: boolean
          persisted_ref?: string | null
          persisted_to?: string
          sage_text?: string | null
          venue_id: string
        }
        Update: {
          confidence_0_100?: number
          created_at?: string
          draft_id?: string
          id?: string
          insight_kind?: string
          learning_summary?: string
          operator_acknowledged_at?: string | null
          operator_correction?: string | null
          operator_text?: string | null
          operator_visible?: boolean
          persisted_ref?: string | null
          persisted_to?: string
          sage_text?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draft_edit_insights_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_edit_insights_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_feedback: {
        Row: {
          action: string
          coordinator_edits: string | null
          created_at: string | null
          draft_id: string
          edited_body: string | null
          id: string
          metadata: Json
          original_body: string | null
          rejection_reason: string | null
          venue_id: string
        }
        Insert: {
          action: string
          coordinator_edits?: string | null
          created_at?: string | null
          draft_id: string
          edited_body?: string | null
          id?: string
          metadata?: Json
          original_body?: string | null
          rejection_reason?: string | null
          venue_id: string
        }
        Update: {
          action?: string
          coordinator_edits?: string | null
          created_at?: string | null
          draft_id?: string
          edited_body?: string | null
          id?: string
          metadata?: Json
          original_body?: string | null
          rejection_reason?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draft_feedback_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_feedback_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      drafts: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          auto_send_attempts: number
          auto_send_last_error: string | null
          auto_send_source: string | null
          auto_sent: boolean | null
          brain_used: string | null
          cancelled_reason: string | null
          cc_emails: string[] | null
          confidence_score: number | null
          context_type: string | null
          correlation_id: string | null
          cost: number | null
          created_at: string | null
          draft_body: string
          escalation_requested: boolean
          feedback_notes: string | null
          follow_up_step: string | null
          id: string
          interaction_id: string | null
          model_used: string | null
          needs_real_address: boolean
          original_sage_body: string | null
          personality_stale_at: string | null
          pricing_stale_at: string | null
          prompt_version_used: string | null
          sent_at: string | null
          status: string
          subject: string | null
          to_email: string | null
          tokens_used: number | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          auto_send_attempts?: number
          auto_send_last_error?: string | null
          auto_send_source?: string | null
          auto_sent?: boolean | null
          brain_used?: string | null
          cancelled_reason?: string | null
          cc_emails?: string[] | null
          confidence_score?: number | null
          context_type?: string | null
          correlation_id?: string | null
          cost?: number | null
          created_at?: string | null
          draft_body: string
          escalation_requested?: boolean
          feedback_notes?: string | null
          follow_up_step?: string | null
          id?: string
          interaction_id?: string | null
          model_used?: string | null
          needs_real_address?: boolean
          original_sage_body?: string | null
          personality_stale_at?: string | null
          pricing_stale_at?: string | null
          prompt_version_used?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          to_email?: string | null
          tokens_used?: number | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          auto_send_attempts?: number
          auto_send_last_error?: string | null
          auto_send_source?: string | null
          auto_sent?: boolean | null
          brain_used?: string | null
          cancelled_reason?: string | null
          cc_emails?: string[] | null
          confidence_score?: number | null
          context_type?: string | null
          correlation_id?: string | null
          cost?: number | null
          created_at?: string | null
          draft_body?: string
          escalation_requested?: boolean
          feedback_notes?: string | null
          follow_up_step?: string | null
          id?: string
          interaction_id?: string | null
          model_used?: string | null
          needs_real_address?: boolean
          original_sage_body?: string | null
          personality_stale_at?: string | null
          pricing_stale_at?: string | null
          prompt_version_used?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          to_email?: string | null
          tokens_used?: number | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drafts_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafts_interaction_id_fkey"
            columns: ["interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafts_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "drafts_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      economic_indicators: {
        Row: {
          date: string
          id: string
          indicator_name: string
          source: string | null
          value: number | null
        }
        Insert: {
          date: string
          id?: string
          indicator_name: string
          source?: string | null
          value?: number | null
        }
        Update: {
          date?: string
          id?: string
          indicator_name?: string
          source?: string | null
          value?: number | null
        }
        Relationships: []
      }
      email_sync_state: {
        Row: {
          error_message: string | null
          id: string
          last_history_id: string | null
          last_sync_at: string | null
          status: string | null
          venue_id: string
        }
        Insert: {
          error_message?: string | null
          id?: string
          last_history_id?: string | null
          last_sync_at?: string | null
          status?: string | null
          venue_id: string
        }
        Update: {
          error_message?: string | null
          id?: string
          last_history_id?: string | null
          last_sync_at?: string | null
          status?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_sync_state_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      engagement_events: {
        Row: {
          confidence_flag: string | null
          correlation_id: string | null
          created_at: string | null
          direction: string
          event_type: string
          id: string
          metadata: Json | null
          occurred_at: string
          points: number
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          confidence_flag?: string | null
          correlation_id?: string | null
          created_at?: string | null
          direction: string
          event_type: string
          id?: string
          metadata?: Json | null
          occurred_at?: string
          points?: number
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          confidence_flag?: string | null
          correlation_id?: string | null
          created_at?: string | null
          direction?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          occurred_at?: string
          points?: number
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "engagement_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "engagement_events_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "engagement_events_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      error_logs: {
        Row: {
          context: Json | null
          correlation_id: string | null
          created_at: string | null
          error_type: string | null
          id: string
          message: string | null
          resolved: boolean | null
          resolved_at: string | null
          resolved_by: string | null
          stack_trace: string | null
          venue_id: string | null
        }
        Insert: {
          context?: Json | null
          correlation_id?: string | null
          created_at?: string | null
          error_type?: string | null
          id?: string
          message?: string | null
          resolved?: boolean | null
          resolved_at?: string | null
          resolved_by?: string | null
          stack_trace?: string | null
          venue_id?: string | null
        }
        Update: {
          context?: Json | null
          correlation_id?: string | null
          created_at?: string | null
          error_type?: string | null
          id?: string
          message?: string | null
          resolved?: boolean | null
          resolved_at?: string | null
          resolved_by?: string | null
          stack_trace?: string | null
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "error_logs_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "error_logs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      essentials_action_log: {
        Row: {
          action: string
          created_at: string
          id: string
          level_at_action: string
          metadata: Json
          surface: string
          user_id: string
          venue_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          level_at_action: string
          metadata?: Json
          surface: string
          user_id: string
          venue_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          level_at_action?: string
          metadata?: Json
          surface?: string
          user_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "essentials_action_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "essentials_action_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      essentials_preferences: {
        Row: {
          created_at: string
          default_level: string
          id: string
          surface_overrides: Json
          updated_at: string
          user_id: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          default_level?: string
          id?: string
          surface_overrides?: Json
          updated_at?: string
          user_id: string
          venue_id: string
        }
        Update: {
          created_at?: string
          default_level?: string
          id?: string
          surface_overrides?: Json
          updated_at?: string
          user_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "essentials_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "essentials_preferences_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      event_feedback: {
        Row: {
          catering_notes: string | null
          catering_quality: number | null
          couple_satisfaction: number | null
          created_at: string | null
          delay_notes: string | null
          delay_phases: string[] | null
          dietary_handling: number | null
          feedback_triggered_at: string | null
          guest_complaint_count: number | null
          guest_complaints: string | null
          id: string
          overall_rating: number
          proactive_response_approved: boolean | null
          proactive_response_draft: string | null
          review_readiness: string | null
          review_readiness_notes: string | null
          service_timing: number | null
          submitted_at: string | null
          submitted_by: string | null
          timeline_adherence: string | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
          what_to_change: string | null
          what_went_well: string | null
        }
        Insert: {
          catering_notes?: string | null
          catering_quality?: number | null
          couple_satisfaction?: number | null
          created_at?: string | null
          delay_notes?: string | null
          delay_phases?: string[] | null
          dietary_handling?: number | null
          feedback_triggered_at?: string | null
          guest_complaint_count?: number | null
          guest_complaints?: string | null
          id?: string
          overall_rating: number
          proactive_response_approved?: boolean | null
          proactive_response_draft?: string | null
          review_readiness?: string | null
          review_readiness_notes?: string | null
          service_timing?: number | null
          submitted_at?: string | null
          submitted_by?: string | null
          timeline_adherence?: string | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
          what_to_change?: string | null
          what_went_well?: string | null
        }
        Update: {
          catering_notes?: string | null
          catering_quality?: number | null
          couple_satisfaction?: number | null
          created_at?: string | null
          delay_notes?: string | null
          delay_phases?: string[] | null
          dietary_handling?: number | null
          feedback_triggered_at?: string | null
          guest_complaint_count?: number | null
          guest_complaints?: string | null
          id?: string
          overall_rating?: number
          proactive_response_approved?: boolean | null
          proactive_response_draft?: string | null
          review_readiness?: string | null
          review_readiness_notes?: string | null
          service_timing?: number | null
          submitted_at?: string | null
          submitted_by?: string | null
          timeline_adherence?: string | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
          what_to_change?: string | null
          what_went_well?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_feedback_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_feedback_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_feedback_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "event_feedback_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      event_feedback_vendors: {
        Row: {
          created_at: string | null
          event_feedback_id: string
          id: string
          notes: string | null
          rating: number
          vendor_id: string | null
          vendor_name: string
          vendor_type: string
          would_recommend: boolean | null
        }
        Insert: {
          created_at?: string | null
          event_feedback_id: string
          id?: string
          notes?: string | null
          rating: number
          vendor_id?: string | null
          vendor_name: string
          vendor_type: string
          would_recommend?: boolean | null
        }
        Update: {
          created_at?: string | null
          event_feedback_id?: string
          id?: string
          notes?: string | null
          rating?: number
          vendor_id?: string | null
          vendor_name?: string
          vendor_type?: string
          would_recommend?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "event_feedback_vendors_event_feedback_id_fkey"
            columns: ["event_feedback_id"]
            isOneToOne: false
            referencedRelation: "event_feedback"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_feedback_vendors_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "booked_vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_overrides: {
        Row: {
          active: boolean
          correction_value: Json | null
          created_at: string
          created_by: string | null
          evidence_kind: string
          evidence_ref: Json
          id: string
          override_action: string
          reason: string | null
          updated_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          active?: boolean
          correction_value?: Json | null
          created_at?: string
          created_by?: string | null
          evidence_kind: string
          evidence_ref: Json
          id?: string
          override_action: string
          reason?: string | null
          updated_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          active?: boolean
          correction_value?: Json | null
          created_at?: string
          created_by?: string | null
          evidence_kind?: string
          evidence_ref?: Json
          id?: string
          override_action?: string
          reason?: string | null
          updated_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "evidence_overrides_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_overrides_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "evidence_overrides_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      external_calendar_events: {
        Row: {
          category: string
          created_at: string
          created_by_writer: string | null
          deleted_at: string | null
          description: string | null
          end_date: string
          geo_scope: string
          id: string
          influence_weight: number | null
          source: string
          start_date: string
          title: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by_writer?: string | null
          deleted_at?: string | null
          description?: string | null
          end_date: string
          geo_scope: string
          id?: string
          influence_weight?: number | null
          source?: string
          start_date: string
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by_writer?: string | null
          deleted_at?: string | null
          description?: string | null
          end_date?: string
          geo_scope?: string
          id?: string
          influence_weight?: number | null
          source?: string
          start_date?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      external_signal_health: {
        Row: {
          last_checked_at: string
          last_error: string | null
          last_refresh_at: string | null
          missing_config_fields: string[] | null
          record_count: number
          signal_name: string
          status: string
          venue_id: string
        }
        Insert: {
          last_checked_at?: string
          last_error?: string | null
          last_refresh_at?: string | null
          missing_config_fields?: string[] | null
          record_count?: number
          signal_name: string
          status: string
          venue_id: string
        }
        Update: {
          last_checked_at?: string
          last_error?: string | null
          last_refresh_at?: string | null
          missing_config_fields?: string[] | null
          record_count?: number
          signal_name?: string
          status?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "external_signal_health_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_up_sequences: {
        Row: {
          channel: string
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          trigger_config: Json | null
          trigger_type: string
          venue_id: string
        }
        Insert: {
          channel?: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          trigger_config?: Json | null
          trigger_type: string
          venue_id: string
        }
        Update: {
          channel?: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          trigger_config?: Json | null
          trigger_type?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_up_sequences_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      founding_member_counter: {
        Row: {
          cap: number
          closes_at: string
          count: number
          id: number
        }
        Insert: {
          cap?: number
          closes_at?: string
          count?: number
          id?: number
        }
        Update: {
          cap?: number
          closes_at?: string
          count?: number
          id?: number
        }
        Relationships: []
      }
      fragments: {
        Row: {
          channel: string
          external_id: string
          handles: Json
          id: string
          identity_hint: string | null
          occurred_at: string
          promoted_at: string | null
          promoted_to_couple_id: string | null
          raw_payload: Json | null
          venue_id: string
        }
        Insert: {
          channel: string
          external_id: string
          handles?: Json
          id?: string
          identity_hint?: string | null
          occurred_at: string
          promoted_at?: string | null
          promoted_to_couple_id?: string | null
          raw_payload?: Json | null
          venue_id: string
        }
        Update: {
          channel?: string
          external_id?: string
          handles?: Json
          id?: string
          identity_hint?: string | null
          occurred_at?: string
          promoted_at?: string | null
          promoted_to_couple_id?: string | null
          raw_payload?: Json | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fragments_promoted_to_couple_id_fkey"
            columns: ["promoted_to_couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fragments_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      fred_indicators: {
        Row: {
          created_at: string
          fetched_at: string
          frequency: string | null
          id: string
          observation_date: string
          region: string | null
          series_id: string
          units: string | null
          value: number | null
        }
        Insert: {
          created_at?: string
          fetched_at?: string
          frequency?: string | null
          id?: string
          observation_date: string
          region?: string | null
          series_id: string
          units?: string | null
          value?: number | null
        }
        Update: {
          created_at?: string
          fetched_at?: string
          frequency?: string | null
          id?: string
          observation_date?: string
          region?: string | null
          series_id?: string
          units?: string | null
          value?: number | null
        }
        Relationships: []
      }
      fred_series_sync_state: {
        Row: {
          last_error: string | null
          last_error_at: string | null
          last_fetched_at: string | null
          series_id: string
          updated_at: string
        }
        Insert: {
          last_error?: string | null
          last_error_at?: string | null
          last_fetched_at?: string | null
          series_id: string
          updated_at?: string
        }
        Update: {
          last_error?: string | null
          last_error_at?: string | null
          last_fetched_at?: string | null
          series_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      gmail_connections: {
        Row: {
          created_at: string | null
          email_address: string
          error_message: string | null
          gmail_tokens: Json
          id: string
          is_primary: boolean | null
          label: string | null
          last_history_id: string | null
          last_sync_at: string | null
          status: string | null
          sync_enabled: boolean | null
          updated_at: string | null
          user_id: string | null
          venue_id: string
        }
        Insert: {
          created_at?: string | null
          email_address: string
          error_message?: string | null
          gmail_tokens: Json
          id?: string
          is_primary?: boolean | null
          label?: string | null
          last_history_id?: string | null
          last_sync_at?: string | null
          status?: string | null
          sync_enabled?: boolean | null
          updated_at?: string | null
          user_id?: string | null
          venue_id: string
        }
        Update: {
          created_at?: string | null
          email_address?: string
          error_message?: string | null
          gmail_tokens?: Json
          id?: string
          is_primary?: boolean | null
          label?: string | null
          last_history_id?: string | null
          last_sync_at?: string | null
          status?: string | null
          sync_enabled?: boolean | null
          updated_at?: string | null
          user_id?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gmail_connections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      google_ads_connections: {
        Row: {
          access_token: string | null
          access_token_expires_at: string | null
          connected_at: string | null
          connected_by: string | null
          created_at: string
          customer_id: string | null
          customer_name: string | null
          id: string
          last_error_at: string | null
          last_error_message: string | null
          last_synced_at: string | null
          last_used_at: string | null
          refresh_token: string | null
          scope: string | null
          status: string
          status_reason: string | null
          token_type: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          access_token?: string | null
          access_token_expires_at?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          last_error_at?: string | null
          last_error_message?: string | null
          last_synced_at?: string | null
          last_used_at?: string | null
          refresh_token?: string | null
          scope?: string | null
          status?: string
          status_reason?: string | null
          token_type?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          access_token?: string | null
          access_token_expires_at?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          last_error_at?: string | null
          last_error_message?: string | null
          last_synced_at?: string | null
          last_used_at?: string | null
          refresh_token?: string | null
          scope?: string | null
          status?: string
          status_reason?: string | null
          token_type?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_ads_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "google_ads_connections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      government_events: {
        Row: {
          created_at: string
          description: string | null
          end_date: string | null
          event_type: string
          id: string
          region: string
          severity: string
          start_date: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          end_date?: string | null
          event_type: string
          id?: string
          region?: string
          severity: string
          start_date: string
        }
        Update: {
          created_at?: string
          description?: string | null
          end_date?: string | null
          event_type?: string
          id?: string
          region?: string
          severity?: string
          start_date?: string
        }
        Relationships: []
      }
      guest_care_notes: {
        Row: {
          care_type: string | null
          created_at: string | null
          guest_name: string
          id: string
          note: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          care_type?: string | null
          created_at?: string | null
          guest_name: string
          id?: string
          note?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          care_type?: string | null
          created_at?: string | null
          guest_name?: string
          id?: string
          note?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_care_notes_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_care_notes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "guest_care_notes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_list: {
        Row: {
          accessibility_notes: string | null
          accommodation: string | null
          address: string | null
          age_bracket: string | null
          care_notes: string | null
          created_at: string | null
          dietary_restrictions: string | null
          email: string | null
          first_name: string | null
          group_name: string | null
          has_plus_one: boolean | null
          id: string
          invitation_sent: boolean | null
          last_name: string | null
          meal_choice: string | null
          meal_option_id: string | null
          meal_preference: string | null
          needs_accessibility: boolean | null
          needs_shuttle: boolean | null
          origin_state: string | null
          person_id: string | null
          phone: string | null
          plus_one: boolean | null
          plus_one_dietary: string | null
          plus_one_meal_choice: string | null
          plus_one_name: string | null
          plus_one_rsvp: string | null
          rsvp_responded_at: string | null
          rsvp_status: string | null
          staying_overnight: boolean | null
          table_assignment: string | null
          table_assignment_id: string | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          accessibility_notes?: string | null
          accommodation?: string | null
          address?: string | null
          age_bracket?: string | null
          care_notes?: string | null
          created_at?: string | null
          dietary_restrictions?: string | null
          email?: string | null
          first_name?: string | null
          group_name?: string | null
          has_plus_one?: boolean | null
          id?: string
          invitation_sent?: boolean | null
          last_name?: string | null
          meal_choice?: string | null
          meal_option_id?: string | null
          meal_preference?: string | null
          needs_accessibility?: boolean | null
          needs_shuttle?: boolean | null
          origin_state?: string | null
          person_id?: string | null
          phone?: string | null
          plus_one?: boolean | null
          plus_one_dietary?: string | null
          plus_one_meal_choice?: string | null
          plus_one_name?: string | null
          plus_one_rsvp?: string | null
          rsvp_responded_at?: string | null
          rsvp_status?: string | null
          staying_overnight?: boolean | null
          table_assignment?: string | null
          table_assignment_id?: string | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          accessibility_notes?: string | null
          accommodation?: string | null
          address?: string | null
          age_bracket?: string | null
          care_notes?: string | null
          created_at?: string | null
          dietary_restrictions?: string | null
          email?: string | null
          first_name?: string | null
          group_name?: string | null
          has_plus_one?: boolean | null
          id?: string
          invitation_sent?: boolean | null
          last_name?: string | null
          meal_choice?: string | null
          meal_option_id?: string | null
          meal_preference?: string | null
          needs_accessibility?: boolean | null
          needs_shuttle?: boolean | null
          origin_state?: string | null
          person_id?: string | null
          phone?: string | null
          plus_one?: boolean | null
          plus_one_dietary?: string | null
          plus_one_meal_choice?: string | null
          plus_one_name?: string | null
          plus_one_rsvp?: string | null
          rsvp_responded_at?: string | null
          rsvp_status?: string | null
          staying_overnight?: boolean | null
          table_assignment?: string | null
          table_assignment_id?: string | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_guest_list_meal_option"
            columns: ["meal_option_id"]
            isOneToOne: false
            referencedRelation: "guest_meal_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_guest_list_table_assignment"
            columns: ["table_assignment_id"]
            isOneToOne: false
            referencedRelation: "seating_tables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_list_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_list_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_list_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "guest_list_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_meal_options: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          is_default: boolean | null
          option_name: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_default?: boolean | null
          option_name: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_default?: boolean | null
          option_name?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_meal_options_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_meal_options_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "guest_meal_options_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_tag_assignments: {
        Row: {
          created_at: string | null
          guest_id: string
          id: string
          tag_id: string
        }
        Insert: {
          created_at?: string | null
          guest_id: string
          id?: string
          tag_id: string
        }
        Update: {
          created_at?: string | null
          guest_id?: string
          id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_tag_assignments_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_tag_assignments_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "guest_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_tags: {
        Row: {
          color: string | null
          created_at: string | null
          id: string
          is_system: boolean | null
          tag_name: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string | null
          id?: string
          is_system?: boolean | null
          tag_name: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          color?: string | null
          created_at?: string | null
          id?: string
          is_system?: boolean | null
          tag_name?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_tags_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_tags_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "guest_tags_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      handle_merge_decisions: {
        Row: {
          created_at: string
          decided_at: string
          decided_by: string | null
          decision: string
          handle_normalised: string
          id: string
          merge_ids: string[]
          note: string | null
          source_records: Json
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          decided_at?: string
          decided_by?: string | null
          decision: string
          handle_normalised: string
          id?: string
          merge_ids?: string[]
          note?: string | null
          source_records?: Json
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          decided_at?: string
          decided_by?: string | null
          decision?: string
          handle_normalised?: string
          id?: string
          merge_ids?: string[]
          note?: string | null
          source_records?: Json
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "handle_merge_decisions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      heat_score_config: {
        Row: {
          decay_rate: number | null
          event_type: string
          id: string
          points: number
          venue_id: string
        }
        Insert: {
          decay_rate?: number | null
          event_type: string
          id?: string
          points?: number
          venue_id: string
        }
        Update: {
          decay_rate?: number | null
          event_type?: string
          id?: string
          points?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "heat_score_config_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      hypothesis_validation_jobs: {
        Row: {
          completed_at: string | null
          discovery_id: string
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          discovery_id: string
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          discovery_id?: string
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hypothesis_validation_jobs_discovery_id_fkey"
            columns: ["discovery_id"]
            isOneToOne: false
            referencedRelation: "intel_discoveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hypothesis_validation_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      hypothesis_validation_runs: {
        Row: {
          confidence_0_100: number
          cost_cents: number
          discovery_id: string
          id: string
          interpretation: string
          prompt_version: string
          reasoning: string | null
          run_at: string
          test_plan: Json
          test_result: Json
          venue_id: string
        }
        Insert: {
          confidence_0_100: number
          cost_cents?: number
          discovery_id: string
          id?: string
          interpretation: string
          prompt_version: string
          reasoning?: string | null
          run_at?: string
          test_plan: Json
          test_result: Json
          venue_id: string
        }
        Update: {
          confidence_0_100?: number
          cost_cents?: number
          discovery_id?: string
          id?: string
          interpretation?: string
          prompt_version?: string
          reasoning?: string | null
          run_at?: string
          test_plan?: Json
          test_result?: Json
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hypothesis_validation_runs_discovery_id_fkey"
            columns: ["discovery_id"]
            isOneToOne: false
            referencedRelation: "intel_discoveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hypothesis_validation_runs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      identity_decision_clusters: {
        Row: {
          aggregate_score: number
          applied_handle_merges: Json | null
          canonical_person_id: string | null
          cluster_key: string
          decided_at: string
          decided_by: string | null
          decision: string
          decision_note: string | null
          handles_involved: Json
          id: string
          total_records: number
          venue_id: string
        }
        Insert: {
          aggregate_score: number
          applied_handle_merges?: Json | null
          canonical_person_id?: string | null
          cluster_key: string
          decided_at?: string
          decided_by?: string | null
          decision: string
          decision_note?: string | null
          handles_involved: Json
          id?: string
          total_records: number
          venue_id: string
        }
        Update: {
          aggregate_score?: number
          applied_handle_merges?: Json | null
          canonical_person_id?: string | null
          cluster_key?: string
          decided_at?: string
          decided_by?: string | null
          decision?: string
          decision_note?: string | null
          handles_involved?: Json
          id?: string
          total_records?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "identity_decision_clusters_canonical_person_id_fkey"
            columns: ["canonical_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_decision_clusters_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      identity_reconstruction_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "identity_reconstruction_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identity_reconstruction_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "identity_reconstruction_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      import_runs: {
        Row: {
          adapter_used: string | null
          completed_at: string | null
          detected_shape: string | null
          errors: Json | null
          file_size_bytes: number | null
          filename: string
          id: string
          ingested_at: string
          ingested_by: string | null
          mime_type: string | null
          reconstruction_enqueued_count: number
          rows_attempted: number | null
          rows_inserted: number | null
          rows_skipped: number | null
          rows_updated: number | null
          skip_reasons: Json | null
          source_path: string
          status: string
          storage_bucket: string
          storage_path: string
          venue_id: string
        }
        Insert: {
          adapter_used?: string | null
          completed_at?: string | null
          detected_shape?: string | null
          errors?: Json | null
          file_size_bytes?: number | null
          filename: string
          id?: string
          ingested_at?: string
          ingested_by?: string | null
          mime_type?: string | null
          reconstruction_enqueued_count?: number
          rows_attempted?: number | null
          rows_inserted?: number | null
          rows_skipped?: number | null
          rows_updated?: number | null
          skip_reasons?: Json | null
          source_path: string
          status: string
          storage_bucket?: string
          storage_path: string
          venue_id: string
        }
        Update: {
          adapter_used?: string | null
          completed_at?: string | null
          detected_shape?: string | null
          errors?: Json | null
          file_size_bytes?: number | null
          filename?: string
          id?: string
          ingested_at?: string
          ingested_by?: string | null
          mime_type?: string | null
          reconstruction_enqueued_count?: number
          rows_attempted?: number | null
          rows_inserted?: number | null
          rows_skipped?: number | null
          rows_updated?: number | null
          skip_reasons?: Json | null
          source_path?: string
          status?: string
          storage_bucket?: string
          storage_path?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_runs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      industry_benchmarks: {
        Row: {
          benchmark_key: string
          best_in_class: number | null
          created_at: string | null
          data_year: number
          description: string | null
          id: string
          label: string
          median: number | null
          p25: number | null
          p75: number | null
          region_type: string | null
          source: string | null
          unit: string | null
          venue_tier: string
        }
        Insert: {
          benchmark_key: string
          best_in_class?: number | null
          created_at?: string | null
          data_year: number
          description?: string | null
          id?: string
          label: string
          median?: number | null
          p25?: number | null
          p75?: number | null
          region_type?: string | null
          source?: string | null
          unit?: string | null
          venue_tier: string
        }
        Update: {
          benchmark_key?: string
          best_in_class?: number | null
          created_at?: string | null
          data_year?: number
          description?: string | null
          id?: string
          label?: string
          median?: number | null
          p25?: number | null
          p75?: number | null
          region_type?: string | null
          source?: string | null
          unit?: string | null
          venue_tier?: string
        }
        Relationships: []
      }
      insight_outcomes: {
        Row: {
          acted_at: string | null
          action_taken: string
          baseline_metric: string
          baseline_period_end: string
          baseline_period_start: string
          baseline_value: number
          created_at: string | null
          id: string
          improvement_pct: number | null
          insight_id: string
          outcome_measured_at: string | null
          outcome_period_end: string | null
          outcome_period_start: string | null
          outcome_value: number | null
          venue_id: string
          verdict: string | null
        }
        Insert: {
          acted_at?: string | null
          action_taken: string
          baseline_metric: string
          baseline_period_end: string
          baseline_period_start: string
          baseline_value: number
          created_at?: string | null
          id?: string
          improvement_pct?: number | null
          insight_id: string
          outcome_measured_at?: string | null
          outcome_period_end?: string | null
          outcome_period_start?: string | null
          outcome_value?: number | null
          venue_id: string
          verdict?: string | null
        }
        Update: {
          acted_at?: string | null
          action_taken?: string
          baseline_metric?: string
          baseline_period_end?: string
          baseline_period_start?: string
          baseline_value?: number
          created_at?: string | null
          id?: string
          improvement_pct?: number | null
          insight_id?: string
          outcome_measured_at?: string | null
          outcome_period_end?: string | null
          outcome_period_start?: string | null
          outcome_value?: number | null
          venue_id?: string
          verdict?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "insight_outcomes_insight_id_fkey"
            columns: ["insight_id"]
            isOneToOne: false
            referencedRelation: "intelligence_insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insight_outcomes_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      inspo_gallery: {
        Row: {
          caption: string | null
          created_at: string | null
          id: string
          image_url: string
          tags: string[] | null
          uploaded_by: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          id?: string
          image_url: string
          tags?: string[] | null
          uploaded_by?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          id?: string
          image_url?: string
          tags?: string[] | null
          uploaded_by?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inspo_gallery_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspo_gallery_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inspo_gallery_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "inspo_gallery_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      instagram_connections: {
        Row: {
          connected_at: string | null
          connected_by: string | null
          created_at: string
          id: string
          ig_business_id: string | null
          ig_username: string | null
          last_error_at: string | null
          last_error_message: string | null
          last_event_at: string | null
          page_access_token: string | null
          page_id: string | null
          page_name: string | null
          page_token_env_key: string | null
          status: string
          status_reason: string | null
          token_expires_at: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          id?: string
          ig_business_id?: string | null
          ig_username?: string | null
          last_error_at?: string | null
          last_error_message?: string | null
          last_event_at?: string | null
          page_access_token?: string | null
          page_id?: string | null
          page_name?: string | null
          page_token_env_key?: string | null
          status?: string
          status_reason?: string | null
          token_expires_at?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          id?: string
          ig_business_id?: string | null
          ig_username?: string | null
          last_error_at?: string | null
          last_error_message?: string | null
          last_event_at?: string | null
          page_access_token?: string | null
          page_id?: string | null
          page_name?: string | null
          page_token_env_key?: string | null
          status?: string
          status_reason?: string | null
          token_expires_at?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "instagram_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instagram_connections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      integrity_remediations: {
        Row: {
          completed_at: string | null
          errors: Json
          fix_strategy: string
          id: string
          invariant_id: string
          mode: string
          operator_id: string | null
          sample_after: Json | null
          sample_before: Json | null
          skip_reasons: Json
          started_at: string
          venue_id: string
          violations_detected: number
          violations_fixed: number
          violations_skipped: number
        }
        Insert: {
          completed_at?: string | null
          errors?: Json
          fix_strategy: string
          id?: string
          invariant_id: string
          mode: string
          operator_id?: string | null
          sample_after?: Json | null
          sample_before?: Json | null
          skip_reasons?: Json
          started_at?: string
          venue_id: string
          violations_detected?: number
          violations_fixed?: number
          violations_skipped?: number
        }
        Update: {
          completed_at?: string | null
          errors?: Json
          fix_strategy?: string
          id?: string
          invariant_id?: string
          mode?: string
          operator_id?: string | null
          sample_after?: Json | null
          sample_before?: Json | null
          skip_reasons?: Json
          started_at?: string
          venue_id?: string
          violations_detected?: number
          violations_fixed?: number
          violations_skipped?: number
        }
        Relationships: [
          {
            foreignKeyName: "integrity_remediations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      intel_acknowledgments: {
        Row: {
          acknowledged_at: string
          acknowledged_by: string | null
          created_at: string
          id: string
          insight_key: string
          insight_kind: string
          note: string | null
          suppress_until: string
          venue_id: string
        }
        Insert: {
          acknowledged_at?: string
          acknowledged_by?: string | null
          created_at?: string
          id?: string
          insight_key: string
          insight_kind: string
          note?: string | null
          suppress_until?: string
          venue_id: string
        }
        Update: {
          acknowledged_at?: string
          acknowledged_by?: string | null
          created_at?: string
          id?: string
          insight_key?: string
          insight_kind?: string
          note?: string | null
          suppress_until?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intel_acknowledgments_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intel_acknowledgments_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      intel_discoveries: {
        Row: {
          action_taken: string | null
          actioned_at: string | null
          confidence_0_100: number
          cost_cents: number
          created_at: string
          dismissal_reason: string | null
          dismissed_at: string | null
          dismissed_by: string | null
          evidence_summary: Json
          feedback_applied_at: string | null
          hypothesis_category: string
          hypothesis_text: string
          hypothesis_title: string
          id: string
          prompt_version: string
          recommended_action_if_validated: string | null
          recommended_test: string | null
          updated_at: string
          validated_at: string | null
          validation_completed_at: string | null
          validation_metric: Json | null
          validation_result_summary: string | null
          validation_runs_count: number
          validation_started_at: string | null
          validation_status: string
          validation_test_plan: Json | null
          venue_id: string
        }
        Insert: {
          action_taken?: string | null
          actioned_at?: string | null
          confidence_0_100: number
          cost_cents?: number
          created_at?: string
          dismissal_reason?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          evidence_summary: Json
          feedback_applied_at?: string | null
          hypothesis_category: string
          hypothesis_text: string
          hypothesis_title: string
          id?: string
          prompt_version: string
          recommended_action_if_validated?: string | null
          recommended_test?: string | null
          updated_at?: string
          validated_at?: string | null
          validation_completed_at?: string | null
          validation_metric?: Json | null
          validation_result_summary?: string | null
          validation_runs_count?: number
          validation_started_at?: string | null
          validation_status?: string
          validation_test_plan?: Json | null
          venue_id: string
        }
        Update: {
          action_taken?: string | null
          actioned_at?: string | null
          confidence_0_100?: number
          cost_cents?: number
          created_at?: string
          dismissal_reason?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          evidence_summary?: Json
          feedback_applied_at?: string | null
          hypothesis_category?: string
          hypothesis_text?: string
          hypothesis_title?: string
          id?: string
          prompt_version?: string
          recommended_action_if_validated?: string | null
          recommended_test?: string | null
          updated_at?: string
          validated_at?: string | null
          validation_completed_at?: string | null
          validation_metric?: Json | null
          validation_result_summary?: string | null
          validation_runs_count?: number
          validation_started_at?: string | null
          validation_status?: string
          validation_test_plan?: Json | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intel_discoveries_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      intel_discovery_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intel_discovery_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      intel_match_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "intel_match_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intel_match_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "intel_match_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      intel_matches: {
        Row: {
          action_taken: string | null
          actioned_at: string | null
          cohort_fit_score_0_100: number | null
          created_at: string
          dismissal_reason: string | null
          dismissed_at: string | null
          dismissed_by: string | null
          evidence_quotes: Json | null
          fired_at: string
          id: string
          match_confidence_0_100: number
          match_reasoning: string | null
          signal_payload: Json
          signal_type: string
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          action_taken?: string | null
          actioned_at?: string | null
          cohort_fit_score_0_100?: number | null
          created_at?: string
          dismissal_reason?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          evidence_quotes?: Json | null
          fired_at?: string
          id?: string
          match_confidence_0_100: number
          match_reasoning?: string | null
          signal_payload: Json
          signal_type: string
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          action_taken?: string | null
          actioned_at?: string | null
          cohort_fit_score_0_100?: number | null
          created_at?: string
          dismissal_reason?: string | null
          dismissed_at?: string | null
          dismissed_by?: string | null
          evidence_quotes?: Json | null
          fired_at?: string
          id?: string
          match_confidence_0_100?: number
          match_reasoning?: string | null
          signal_payload?: Json
          signal_type?: string
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "intel_matches_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intel_matches_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "intel_matches_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_extractions: {
        Row: {
          confidence: number | null
          created_at: string | null
          extraction_type: string
          id: string
          interaction_id: string | null
          metadata: Json | null
          value: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          extraction_type: string
          id?: string
          interaction_id?: string | null
          metadata?: Json | null
          value?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          extraction_type?: string
          id?: string
          interaction_id?: string | null
          metadata?: Json | null
          value?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_extractions_interaction_id_fkey"
            columns: ["interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_extractions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_extractions_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "intelligence_extractions_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      intelligence_insights: {
        Row: {
          acted_on_at: string | null
          action: string | null
          body: string
          cache_key: string | null
          category: string
          compared_to: string | null
          confidence: number | null
          context_id: string | null
          correlation_id: string | null
          created_at: string | null
          data_points: Json | null
          dismissed_at: string | null
          expires_at: string | null
          id: string
          impact_score: number | null
          insight_type: string
          last_classical_signature: Json | null
          llm_model_used: string | null
          narration_source: string | null
          org_id: string | null
          priority: string | null
          prompt_version_used: string | null
          seen_at: string | null
          status: string | null
          surface_layer: string | null
          surface_priority: number | null
          title: string
          updated_at: string | null
          venue_id: string
        }
        Insert: {
          acted_on_at?: string | null
          action?: string | null
          body: string
          cache_key?: string | null
          category: string
          compared_to?: string | null
          confidence?: number | null
          context_id?: string | null
          correlation_id?: string | null
          created_at?: string | null
          data_points?: Json | null
          dismissed_at?: string | null
          expires_at?: string | null
          id?: string
          impact_score?: number | null
          insight_type: string
          last_classical_signature?: Json | null
          llm_model_used?: string | null
          narration_source?: string | null
          org_id?: string | null
          priority?: string | null
          prompt_version_used?: string | null
          seen_at?: string | null
          status?: string | null
          surface_layer?: string | null
          surface_priority?: number | null
          title: string
          updated_at?: string | null
          venue_id: string
        }
        Update: {
          acted_on_at?: string | null
          action?: string | null
          body?: string
          cache_key?: string | null
          category?: string
          compared_to?: string | null
          confidence?: number | null
          context_id?: string | null
          correlation_id?: string | null
          created_at?: string | null
          data_points?: Json | null
          dismissed_at?: string | null
          expires_at?: string | null
          id?: string
          impact_score?: number | null
          insight_type?: string
          last_classical_signature?: Json | null
          llm_model_used?: string | null
          narration_source?: string | null
          org_id?: string | null
          priority?: string | null
          prompt_version_used?: string | null
          seen_at?: string | null
          status?: string | null
          surface_layer?: string | null
          surface_priority?: number | null
          title?: string
          updated_at?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "intelligence_insights_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intelligence_insights_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      interactions: {
        Row: {
          author_class: string
          author_class_decided_at: string | null
          author_class_overridden_at: string | null
          author_class_overridden_by: string | null
          author_class_prompt_version: string | null
          body_preview: string | null
          confidence_flag: string | null
          correlation_id: string | null
          created_at: string | null
          crm_source: string | null
          direction: string
          disclosure_version: string | null
          escalation_decided_at: string | null
          escalation_reason: string | null
          escalation_requested: boolean
          extracted_facts: Json | null
          extracted_identity: Json | null
          family_mentioned: boolean | null
          from_email: string | null
          from_name: string | null
          full_body: string | null
          gmail_connection_id: string | null
          gmail_message_id: string | null
          gmail_thread_id: string | null
          haiku_classified_at: string | null
          id: string
          intent_class: string | null
          intent_classified_at: string | null
          intent_classifier_note: string | null
          intent_referenced_couple_name: string | null
          lifecycle_folder: string | null
          lifecycle_signal: string | null
          person_id: string | null
          rfc2822_headers: Json | null
          sentiment: string | null
          signal_class: string
          sms_escalation_reason: string | null
          sms_escalation_requested_at: string | null
          sms_lifecycle_folder: string | null
          subject: string | null
          surface: string
          timestamp: string
          to_email: string | null
          type: string
          urgency: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          author_class?: string
          author_class_decided_at?: string | null
          author_class_overridden_at?: string | null
          author_class_overridden_by?: string | null
          author_class_prompt_version?: string | null
          body_preview?: string | null
          confidence_flag?: string | null
          correlation_id?: string | null
          created_at?: string | null
          crm_source?: string | null
          direction: string
          disclosure_version?: string | null
          escalation_decided_at?: string | null
          escalation_reason?: string | null
          escalation_requested?: boolean
          extracted_facts?: Json | null
          extracted_identity?: Json | null
          family_mentioned?: boolean | null
          from_email?: string | null
          from_name?: string | null
          full_body?: string | null
          gmail_connection_id?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          haiku_classified_at?: string | null
          id?: string
          intent_class?: string | null
          intent_classified_at?: string | null
          intent_classifier_note?: string | null
          intent_referenced_couple_name?: string | null
          lifecycle_folder?: string | null
          lifecycle_signal?: string | null
          person_id?: string | null
          rfc2822_headers?: Json | null
          sentiment?: string | null
          signal_class: string
          sms_escalation_reason?: string | null
          sms_escalation_requested_at?: string | null
          sms_lifecycle_folder?: string | null
          subject?: string | null
          surface?: string
          timestamp?: string
          to_email?: string | null
          type: string
          urgency?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          author_class?: string
          author_class_decided_at?: string | null
          author_class_overridden_at?: string | null
          author_class_overridden_by?: string | null
          author_class_prompt_version?: string | null
          body_preview?: string | null
          confidence_flag?: string | null
          correlation_id?: string | null
          created_at?: string | null
          crm_source?: string | null
          direction?: string
          disclosure_version?: string | null
          escalation_decided_at?: string | null
          escalation_reason?: string | null
          escalation_requested?: boolean
          extracted_facts?: Json | null
          extracted_identity?: Json | null
          family_mentioned?: boolean | null
          from_email?: string | null
          from_name?: string | null
          full_body?: string | null
          gmail_connection_id?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          haiku_classified_at?: string | null
          id?: string
          intent_class?: string | null
          intent_classified_at?: string | null
          intent_classifier_note?: string | null
          intent_referenced_couple_name?: string | null
          lifecycle_folder?: string | null
          lifecycle_signal?: string | null
          person_id?: string | null
          rfc2822_headers?: Json | null
          sentiment?: string | null
          signal_class?: string
          sms_escalation_reason?: string | null
          sms_escalation_requested_at?: string | null
          sms_lifecycle_folder?: string | null
          subject?: string | null
          surface?: string
          timestamp?: string
          to_email?: string | null
          type?: string
          urgency?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "interactions_author_class_overridden_by_fkey"
            columns: ["author_class_overridden_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_gmail_connection_id_fkey"
            columns: ["gmail_connection_id"]
            isOneToOne: false
            referencedRelation: "gmail_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "interactions_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      knot_visitor_activity: {
        Row: {
          action_at: string
          action_taken: string
          city: string | null
          couple_id: string | null
          created_at: string
          id: string
          import_batch_id: string | null
          person_id: string | null
          row_fingerprint: string
          state: string | null
          updated_at: string
          venue_id: string
          visitor_first_name: string | null
          visitor_last_initial: string | null
          visitor_name: string
        }
        Insert: {
          action_at: string
          action_taken: string
          city?: string | null
          couple_id?: string | null
          created_at?: string
          id?: string
          import_batch_id?: string | null
          person_id?: string | null
          row_fingerprint: string
          state?: string | null
          updated_at?: string
          venue_id: string
          visitor_first_name?: string | null
          visitor_last_initial?: string | null
          visitor_name: string
        }
        Update: {
          action_at?: string
          action_taken?: string
          city?: string | null
          couple_id?: string | null
          created_at?: string
          id?: string
          import_batch_id?: string | null
          person_id?: string | null
          row_fingerprint?: string
          state?: string | null
          updated_at?: string
          venue_id?: string
          visitor_first_name?: string | null
          visitor_last_initial?: string | null
          visitor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "knot_visitor_activity_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knot_visitor_activity_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knot_visitor_activity_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_base: {
        Row: {
          answer: string
          category: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          keywords: string[] | null
          priority: number | null
          question: string
          raw_import_row: Json | null
          source: string | null
          updated_at: string | null
          venue_id: string
        }
        Insert: {
          answer: string
          category?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          keywords?: string[] | null
          priority?: number | null
          question: string
          raw_import_row?: Json | null
          source?: string | null
          updated_at?: string | null
          venue_id: string
        }
        Update: {
          answer?: string
          category?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          keywords?: string[] | null
          priority?: number | null
          question?: string
          raw_import_row?: Json | null
          source?: string | null
          updated_at?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_base_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_captures: {
        Row: {
          active: boolean
          answer: string
          applies_until: string | null
          confidence_0_100: number
          created_at: string
          created_by: string | null
          id: string
          knowledge_gap_id: string | null
          question: string
          source_kind: string
          tags: string[]
          updated_at: string
          venue_id: string
        }
        Insert: {
          active?: boolean
          answer: string
          applies_until?: string | null
          confidence_0_100?: number
          created_at?: string
          created_by?: string | null
          id?: string
          knowledge_gap_id?: string | null
          question: string
          source_kind?: string
          tags?: string[]
          updated_at?: string
          venue_id: string
        }
        Update: {
          active?: boolean
          answer?: string
          applies_until?: string | null
          confidence_0_100?: number
          created_at?: string
          created_by?: string | null
          id?: string
          knowledge_gap_id?: string | null
          question?: string
          source_kind?: string
          tags?: string[]
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_captures_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_captures_knowledge_gap_id_fkey"
            columns: ["knowledge_gap_id"]
            isOneToOne: false
            referencedRelation: "knowledge_gaps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_captures_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_gaps: {
        Row: {
          captured_at: string | null
          captured_id: string | null
          category: string
          created_at: string | null
          dismissed_at: string | null
          dismissed_reason: string | null
          frequency: number | null
          id: string
          question: string
          resolution: string | null
          resolved_at: string | null
          status: string | null
          venue_id: string
        }
        Insert: {
          captured_at?: string | null
          captured_id?: string | null
          category: string
          created_at?: string | null
          dismissed_at?: string | null
          dismissed_reason?: string | null
          frequency?: number | null
          id?: string
          question: string
          resolution?: string | null
          resolved_at?: string | null
          status?: string | null
          venue_id: string
        }
        Update: {
          captured_at?: string | null
          captured_id?: string | null
          category?: string
          created_at?: string | null
          dismissed_at?: string | null
          dismissed_reason?: string | null
          frequency?: number | null
          id?: string
          question?: string
          resolution?: string | null
          resolved_at?: string | null
          status?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_gaps_captured_id_fkey"
            columns: ["captured_id"]
            isOneToOne: false
            referencedRelation: "knowledge_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_gaps_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_score_history: {
        Row: {
          calculated_at: string | null
          id: string
          score: number
          temperature_tier: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          calculated_at?: string | null
          id?: string
          score: number
          temperature_tier?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          calculated_at?: string | null
          id?: string
          score?: number
          temperature_tier?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_score_history_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_score_history_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "lead_score_history_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_source_derivation_log: {
        Row: {
          confidence: string
          created_at: string
          decided_by: string
          decided_by_user_id: string | null
          derived_at: string
          derived_source: string | null
          evidence: Json
          id: string
          priority_used: number
          reason: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          confidence: string
          created_at?: string
          decided_by?: string
          decided_by_user_id?: string | null
          derived_at?: string
          derived_source?: string | null
          evidence?: Json
          id?: string
          priority_used: number
          reason?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          confidence?: string
          created_at?: string
          decided_by?: string
          decided_by_user_id?: string | null
          derived_at?: string
          derived_source?: string | null
          evidence?: Json
          id?: string
          priority_used?: number
          reason?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_source_derivation_log_decided_by_user_id_fkey"
            columns: ["decided_by_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_source_derivation_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_source_derivation_log_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "lead_source_derivation_log_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      learned_preferences: {
        Row: {
          confidence: number | null
          created_at: string | null
          id: string
          pattern: string
          preference_type: string
          venue_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          id?: string
          pattern: string
          preference_type: string
          venue_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          id?: string
          pattern?: string
          preference_type?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "learned_preferences_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      lifecycle_transition_jobs: {
        Row: {
          candidate_stage: string | null
          completed_at: string | null
          current_stage: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          candidate_stage?: string | null
          completed_at?: string | null
          current_stage?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          candidate_stage?: string | null
          completed_at?: string | null
          current_stage?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lifecycle_transition_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lifecycle_transition_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "lifecycle_transition_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      lifecycle_transitions: {
        Row: {
          confidence: number | null
          evidence: Json | null
          from_stage: string | null
          id: string
          reasoning: string | null
          to_stage: string
          transition_kind: string
          transitioned_at: string
          transitioned_by: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          confidence?: number | null
          evidence?: Json | null
          from_stage?: string | null
          id?: string
          reasoning?: string | null
          to_stage: string
          transition_kind: string
          transitioned_at?: string
          transitioned_by?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          confidence?: number | null
          evidence?: Json | null
          from_stage?: string | null
          id?: string
          reasoning?: string | null
          to_stage?: string
          transition_kind?: string
          transitioned_at?: string
          transitioned_by?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lifecycle_transitions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lifecycle_transitions_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "lifecycle_transitions_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      listing_platform_patterns: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          pattern_type: string
          pattern_value: string
          platform: string
          platform_canonical: string | null
          source: string | null
          venue_id: string | null
          weight: number
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          pattern_type: string
          pattern_value: string
          platform: string
          platform_canonical?: string | null
          source?: string | null
          venue_id?: string | null
          weight?: number
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          pattern_type?: string
          pattern_value?: string
          platform?: string
          platform_canonical?: string | null
          source?: string | null
          venue_id?: string | null
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "knot_template_patterns_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      lost_deals: {
        Row: {
          competitor_name: string | null
          created_at: string | null
          crm_source: string | null
          id: string
          lost_at: string | null
          lost_at_stage: string | null
          reason_category: string | null
          reason_detail: string | null
          recovery_attempted: boolean | null
          recovery_outcome: string | null
          signal_class: string
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          competitor_name?: string | null
          created_at?: string | null
          crm_source?: string | null
          id?: string
          lost_at?: string | null
          lost_at_stage?: string | null
          reason_category?: string | null
          reason_detail?: string | null
          recovery_attempted?: boolean | null
          recovery_outcome?: string | null
          signal_class: string
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          competitor_name?: string | null
          created_at?: string | null
          crm_source?: string | null
          id?: string
          lost_at?: string | null
          lost_at_stage?: string | null
          reason_category?: string | null
          reason_detail?: string | null
          recovery_attempted?: boolean | null
          recovery_outcome?: string | null
          signal_class?: string
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lost_deals_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_deals_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "lost_deals_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      makeup_schedule: {
        Row: {
          created_at: string | null
          duration: number | null
          hair_duration: number | null
          hair_time: string | null
          id: string
          makeup_duration: number | null
          makeup_time: string | null
          notes: string | null
          person_name: string
          role: string | null
          sort_order: number | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          created_at?: string | null
          duration?: number | null
          hair_duration?: number | null
          hair_time?: string | null
          id?: string
          makeup_duration?: number | null
          makeup_time?: string | null
          notes?: string | null
          person_name: string
          role?: string | null
          sort_order?: number | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          created_at?: string | null
          duration?: number | null
          hair_duration?: number | null
          hair_time?: string | null
          id?: string
          makeup_duration?: number | null
          makeup_time?: string | null
          notes?: string | null
          person_name?: string
          role?: string | null
          sort_order?: number | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "makeup_schedule_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "makeup_schedule_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "makeup_schedule_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      market_intelligence: {
        Row: {
          age_18_34_pct: number | null
          avg_guest_count: number | null
          avg_venue_price: number | null
          avg_wedding_cost: number | null
          bachelors_or_higher_pct: number | null
          booking_seasonality: number[] | null
          consumer_confidence_index: number | null
          created_at: string | null
          data_year: number
          id: string
          inquiry_seasonality: number[] | null
          marriage_rate_per_1000: number | null
          marriages_per_year: number | null
          median_age: number | null
          median_household_income: number | null
          nearby_venue_density: string | null
          population: number | null
          price_position: string | null
          region_key: string
          region_name: string
          region_type: string
          source: string | null
          unemployment_rate: number | null
          updated_at: string | null
          venue_count_estimate: number | null
        }
        Insert: {
          age_18_34_pct?: number | null
          avg_guest_count?: number | null
          avg_venue_price?: number | null
          avg_wedding_cost?: number | null
          bachelors_or_higher_pct?: number | null
          booking_seasonality?: number[] | null
          consumer_confidence_index?: number | null
          created_at?: string | null
          data_year: number
          id?: string
          inquiry_seasonality?: number[] | null
          marriage_rate_per_1000?: number | null
          marriages_per_year?: number | null
          median_age?: number | null
          median_household_income?: number | null
          nearby_venue_density?: string | null
          population?: number | null
          price_position?: string | null
          region_key: string
          region_name: string
          region_type: string
          source?: string | null
          unemployment_rate?: number | null
          updated_at?: string | null
          venue_count_estimate?: number | null
        }
        Update: {
          age_18_34_pct?: number | null
          avg_guest_count?: number | null
          avg_venue_price?: number | null
          avg_wedding_cost?: number | null
          bachelors_or_higher_pct?: number | null
          booking_seasonality?: number[] | null
          consumer_confidence_index?: number | null
          created_at?: string | null
          data_year?: number
          id?: string
          inquiry_seasonality?: number[] | null
          marriage_rate_per_1000?: number | null
          marriages_per_year?: number | null
          median_age?: number | null
          median_household_income?: number | null
          nearby_venue_density?: string | null
          population?: number | null
          price_position?: string | null
          region_key?: string
          region_name?: string
          region_type?: string
          source?: string | null
          unemployment_rate?: number | null
          updated_at?: string | null
          venue_count_estimate?: number | null
        }
        Relationships: []
      }
      marketing_ab_tests: {
        Row: {
          channel: string
          created_at: string
          ended_at: string | null
          hypothesis: string
          id: string
          notes: string | null
          started_at: string
          status: string
          target_persona: string | null
          test_name: string
          variant_a_attribution_event_ids: string[]
          variant_a_label: string
          variant_b_attribution_event_ids: string[]
          variant_b_label: string
          venue_id: string
          winner: string | null
          winner_decided_at: string | null
          winner_decided_by: string | null
          winner_decision_lift_pct: number | null
        }
        Insert: {
          channel: string
          created_at?: string
          ended_at?: string | null
          hypothesis: string
          id?: string
          notes?: string | null
          started_at?: string
          status?: string
          target_persona?: string | null
          test_name: string
          variant_a_attribution_event_ids?: string[]
          variant_a_label: string
          variant_b_attribution_event_ids?: string[]
          variant_b_label: string
          venue_id: string
          winner?: string | null
          winner_decided_at?: string | null
          winner_decided_by?: string | null
          winner_decision_lift_pct?: number | null
        }
        Update: {
          channel?: string
          created_at?: string
          ended_at?: string | null
          hypothesis?: string
          id?: string
          notes?: string | null
          started_at?: string
          status?: string
          target_persona?: string | null
          test_name?: string
          variant_a_attribution_event_ids?: string[]
          variant_a_label?: string
          variant_b_attribution_event_ids?: string[]
          variant_b_label?: string
          venue_id?: string
          winner?: string | null
          winner_decided_at?: string | null
          winner_decided_by?: string | null
          winner_decision_lift_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "marketing_ab_tests_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_agencies: {
        Row: {
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          created_by: string | null
          default_monthly_retainer_cents: number | null
          deleted_at: string | null
          id: string
          name: string
          notes: string | null
          org_id: string | null
          performance_fee_pct: number | null
          services: Json
          updated_at: string
          venue_id: string | null
          website: string | null
        }
        Insert: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by?: string | null
          default_monthly_retainer_cents?: number | null
          deleted_at?: string | null
          id?: string
          name: string
          notes?: string | null
          org_id?: string | null
          performance_fee_pct?: number | null
          services?: Json
          updated_at?: string
          venue_id?: string | null
          website?: string | null
        }
        Update: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by?: string | null
          default_monthly_retainer_cents?: number | null
          deleted_at?: string | null
          id?: string
          name?: string
          notes?: string | null
          org_id?: string | null
          performance_fee_pct?: number | null
          services?: Json
          updated_at?: string
          venue_id?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "marketing_agencies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_agencies_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_agencies_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_channels: {
        Row: {
          activated_at: string
          category: string | null
          created_at: string
          deleted_at: string | null
          id: string
          is_active: boolean
          key: string
          label: string
          managed_by_agency_id: string | null
          notes: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          activated_at?: string
          category?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          key: string
          label: string
          managed_by_agency_id?: string | null
          notes?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          activated_at?: string
          category?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          key?: string
          label?: string
          managed_by_agency_id?: string | null
          notes?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_channels_managed_by_agency_id_fkey"
            columns: ["managed_by_agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_channels_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_digests: {
        Row: {
          cost_cents: number
          created_at: string
          delivered_at: string | null
          delivered_via: string | null
          digest_jsonb: Json
          digest_period_end: string
          digest_period_start: string
          generated_at: string
          id: string
          prompt_version: string | null
          venue_id: string
        }
        Insert: {
          cost_cents?: number
          created_at?: string
          delivered_at?: string | null
          delivered_via?: string | null
          digest_jsonb: Json
          digest_period_end: string
          digest_period_start: string
          generated_at?: string
          id?: string
          prompt_version?: string | null
          venue_id: string
        }
        Update: {
          cost_cents?: number
          created_at?: string
          delivered_at?: string | null
          delivered_via?: string | null
          digest_jsonb?: Json
          digest_period_end?: string
          digest_period_start?: string
          generated_at?: string
          id?: string
          prompt_version?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_digests_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_loop_jobs: {
        Row: {
          completed_at: string | null
          cost_cents: number | null
          enqueued_at: string
          error_text: string | null
          id: string
          job_kind: string
          results_jsonb: Json | null
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          cost_cents?: number | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          job_kind?: string
          results_jsonb?: Json | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          cost_cents?: number | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          job_kind?: string
          results_jsonb?: Json | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_loop_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_recommendation_jobs: {
        Row: {
          completed_at: string | null
          cost_cents: number | null
          enqueued_at: string
          error_text: string | null
          id: string
          recommendations_produced: number | null
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          cost_cents?: number | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          recommendations_produced?: number | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          cost_cents?: number | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          recommendations_produced?: number | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_recommendation_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_recommendations: {
        Row: {
          action_type: string
          actioned_at: string | null
          confidence_0_100: number
          cost_cents: number
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          estimated_monthly_dollar_impact_cents: number | null
          generated_at: string
          id: string
          input_data_hash: string
          measured_outcome_cents: number | null
          n_too_small_warning: boolean
          prompt_version: string
          reasoning_chain: Json
          recommendation_text: string
          recommendation_title: string
          source_channel: string | null
          status: string
          target_channel: string | null
          target_persona: string | null
          venue_id: string
        }
        Insert: {
          action_type: string
          actioned_at?: string | null
          confidence_0_100: number
          cost_cents?: number
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          estimated_monthly_dollar_impact_cents?: number | null
          generated_at?: string
          id?: string
          input_data_hash: string
          measured_outcome_cents?: number | null
          n_too_small_warning?: boolean
          prompt_version: string
          reasoning_chain: Json
          recommendation_text: string
          recommendation_title: string
          source_channel?: string | null
          status?: string
          target_channel?: string | null
          target_persona?: string | null
          venue_id: string
        }
        Update: {
          action_type?: string
          actioned_at?: string | null
          confidence_0_100?: number
          cost_cents?: number
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          estimated_monthly_dollar_impact_cents?: number | null
          generated_at?: string
          id?: string
          input_data_hash?: string
          measured_outcome_cents?: number | null
          n_too_small_warning?: boolean
          prompt_version?: string
          reasoning_chain?: Json
          recommendation_text?: string
          recommendation_title?: string
          source_channel?: string | null
          status?: string
          target_channel?: string | null
          target_persona?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_recommendations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_spend: {
        Row: {
          amount: number
          confidence_flag: string | null
          created_at: string | null
          id: string
          month: string
          notes: string | null
          raw_import_row: Json | null
          source: string
          source_provenance: string
          updated_at: string | null
          venue_id: string
        }
        Insert: {
          amount?: number
          confidence_flag?: string | null
          created_at?: string | null
          id?: string
          month: string
          notes?: string | null
          raw_import_row?: Json | null
          source: string
          source_provenance?: string
          updated_at?: string | null
          venue_id: string
        }
        Update: {
          amount?: number
          confidence_flag?: string | null
          created_at?: string | null
          id?: string
          month?: string
          notes?: string | null
          raw_import_row?: Json | null
          source?: string
          source_provenance?: string
          updated_at?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_spend_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_spend_flags: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          acknowledgment_note: string | null
          cohort_data: Json
          created_at: string
          duration_days: number
          estimated_impact_cents: number | null
          first_detected_at: string
          flag_text: string
          flag_title: string
          flag_type: string
          id: string
          last_confirmed_at: string
          recommended_action: string | null
          resolved_at: string | null
          severity: string
          source_channel: string | null
          status: string
          target_persona: string | null
          venue_id: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          acknowledgment_note?: string | null
          cohort_data: Json
          created_at?: string
          duration_days?: number
          estimated_impact_cents?: number | null
          first_detected_at?: string
          flag_text: string
          flag_title: string
          flag_type: string
          id?: string
          last_confirmed_at?: string
          recommended_action?: string | null
          resolved_at?: string | null
          severity: string
          source_channel?: string | null
          status?: string
          target_persona?: string | null
          venue_id: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          acknowledgment_note?: string | null
          cohort_data?: Json
          created_at?: string
          duration_days?: number
          estimated_impact_cents?: number | null
          first_detected_at?: string
          flag_text?: string
          flag_title?: string
          flag_type?: string
          id?: string
          last_confirmed_at?: string
          recommended_action?: string | null
          resolved_at?: string | null
          severity?: string
          source_channel?: string | null
          status?: string
          target_persona?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_spend_flags_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_spend_jobs: {
        Row: {
          completed_at: string | null
          connector: string
          enqueued_at: string
          error_text: string | null
          id: string
          payload: Json | null
          rows_ingested: number
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          connector: string
          enqueued_at?: string
          error_text?: string | null
          id?: string
          payload?: Json | null
          rows_ingested?: number
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          connector?: string
          enqueued_at?: string
          error_text?: string | null
          id?: string
          payload?: Json | null
          rows_ingested?: number
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_spend_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_spend_records: {
        Row: {
          agency_id: string | null
          amount_cents: number
          campaign_id: string | null
          campaign_name: string | null
          channel: string
          created_at: string
          currency: string
          id: string
          ingested_at: string
          ingested_by: string | null
          source_platform_metadata: Json
          spend_date: string
          venue_id: string
        }
        Insert: {
          agency_id?: string | null
          amount_cents: number
          campaign_id?: string | null
          campaign_name?: string | null
          channel: string
          created_at?: string
          currency?: string
          id?: string
          ingested_at?: string
          ingested_by?: string | null
          source_platform_metadata?: Json
          spend_date: string
          venue_id: string
        }
        Update: {
          agency_id?: string | null
          amount_cents?: number
          campaign_id?: string | null
          campaign_name?: string | null
          channel?: string
          created_at?: string
          currency?: string
          id?: string
          ingested_at?: string
          ingested_by?: string | null
          source_platform_metadata?: Json
          spend_date?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_spend_records_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_spend_records_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      measure_outcome_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          snapshots_measured: number | null
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          snapshots_measured?: number | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          snapshots_measured?: number | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "measure_outcome_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "measure_outcome_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "measure_outcome_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      merge_reattachment_log: {
        Row: {
          attribution_events_moved: number
          candidates_moved: number
          fired_at: string
          id: string
          loser_wedding_id: string
          touchpoints_moved: number
          winner_wedding_id: string
        }
        Insert: {
          attribution_events_moved?: number
          candidates_moved?: number
          fired_at?: string
          id?: string
          loser_wedding_id: string
          touchpoints_moved?: number
          winner_wedding_id: string
        }
        Update: {
          attribution_events_moved?: number
          candidates_moved?: number
          fired_at?: string
          id?: string
          loser_wedding_id?: string
          touchpoints_moved?: number
          winner_wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "merge_reattachment_log_loser_wedding_id_fkey"
            columns: ["loser_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "merge_reattachment_log_loser_wedding_id_fkey"
            columns: ["loser_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merge_reattachment_log_winner_wedding_id_fkey"
            columns: ["winner_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "merge_reattachment_log_winner_wedding_id_fkey"
            columns: ["winner_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          content: string
          created_at: string | null
          id: string
          read_at: string | null
          sender_id: string | null
          sender_role: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          content: string
          created_at?: string | null
          id?: string
          read_at?: string | null
          sender_id?: string | null
          sender_role?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          read_at?: string | null
          sender_id?: string | null
          sender_role?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "messages_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      meta_ads_connections: {
        Row: {
          access_token: string | null
          ad_account_id: string | null
          ad_account_name: string | null
          business_id: string | null
          connected_at: string | null
          connected_by: string | null
          created_at: string
          id: string
          last_error_at: string | null
          last_error_message: string | null
          last_synced_at: string | null
          scope: string | null
          status: string
          status_reason: string | null
          token_env_key: string | null
          token_expires_at: string | null
          token_type: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          access_token?: string | null
          ad_account_id?: string | null
          ad_account_name?: string | null
          business_id?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          id?: string
          last_error_at?: string | null
          last_error_message?: string | null
          last_synced_at?: string | null
          scope?: string | null
          status?: string
          status_reason?: string | null
          token_env_key?: string | null
          token_expires_at?: string | null
          token_type?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          access_token?: string | null
          ad_account_id?: string | null
          ad_account_name?: string | null
          business_id?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          id?: string
          last_error_at?: string | null
          last_error_message?: string | null
          last_synced_at?: string | null
          scope?: string | null
          status?: string
          status_reason?: string | null
          token_env_key?: string | null
          token_expires_at?: string | null
          token_type?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "meta_ads_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meta_ads_connections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      metered_events: {
        Row: {
          counter_name: string
          dimension: Json
          id: string
          observed_at: string
          value: number
          venue_id: string | null
        }
        Insert: {
          counter_name: string
          dimension?: Json
          id?: string
          observed_at?: string
          value?: number
          venue_id?: string | null
        }
        Update: {
          counter_name?: string
          dimension?: Json
          id?: string
          observed_at?: string
          value?: number
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "metered_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      mint_wedding_telemetry: {
        Row: {
          correlation_id: string | null
          created_at: string
          error_message: string | null
          errored: boolean
          id: string
          is_new_person: boolean | null
          is_new_wedding: boolean | null
          latency_ms: number | null
          person_id: string | null
          reason: string | null
          resolved_via: string | null
          source: string
          venue_id: string | null
          wedding_id: string | null
        }
        Insert: {
          correlation_id?: string | null
          created_at?: string
          error_message?: string | null
          errored?: boolean
          id?: string
          is_new_person?: boolean | null
          is_new_wedding?: boolean | null
          latency_ms?: number | null
          person_id?: string | null
          reason?: string | null
          resolved_via?: string | null
          source: string
          venue_id?: string | null
          wedding_id?: string | null
        }
        Update: {
          correlation_id?: string | null
          created_at?: string
          error_message?: string | null
          errored?: boolean
          id?: string
          is_new_person?: boolean | null
          is_new_wedding?: boolean | null
          latency_ms?: number | null
          person_id?: string | null
          reason?: string | null
          resolved_via?: string | null
          source?: string
          venue_id?: string | null
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mint_wedding_telemetry_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mint_wedding_telemetry_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mint_wedding_telemetry_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "mint_wedding_telemetry_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      multi_channel_inbox_settings: {
        Row: {
          created_at: string | null
          sms_enabled: boolean | null
          twilio_phone_numbers: string[] | null
          updated_at: string | null
          venue_id: string
          voice_capture_enabled: boolean | null
          zoom_account_emails: string[] | null
          zoom_enabled: boolean | null
        }
        Insert: {
          created_at?: string | null
          sms_enabled?: boolean | null
          twilio_phone_numbers?: string[] | null
          updated_at?: string | null
          venue_id: string
          voice_capture_enabled?: boolean | null
          zoom_account_emails?: string[] | null
          zoom_enabled?: boolean | null
        }
        Update: {
          created_at?: string | null
          sms_enabled?: boolean | null
          twilio_phone_numbers?: string[] | null
          updated_at?: string | null
          venue_id?: string
          voice_capture_enabled?: boolean | null
          zoom_account_emails?: string[] | null
          zoom_enabled?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "multi_channel_inbox_settings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      natural_language_queries: {
        Row: {
          cost: number | null
          created_at: string | null
          helpful: boolean | null
          id: string
          model_used: string | null
          query_text: string
          response_text: string | null
          tokens_used: number | null
          user_id: string | null
          venue_id: string
        }
        Insert: {
          cost?: number | null
          created_at?: string | null
          helpful?: boolean | null
          id?: string
          model_used?: string | null
          query_text: string
          response_text?: string | null
          tokens_used?: number | null
          user_id?: string | null
          venue_id: string
        }
        Update: {
          cost?: number | null
          created_at?: string | null
          helpful?: boolean | null
          id?: string
          model_used?: string | null
          query_text?: string
          response_text?: string | null
          tokens_used?: number | null
          user_id?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "natural_language_queries_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "natural_language_queries_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_tokens: {
        Row: {
          created_at: string | null
          id: string
          platform: string | null
          token: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          platform?: string | null
          token: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          platform?: string | null
          token?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_backfill_progress: {
        Row: {
          category: string
          created_at: string
          id: string
          last_evaluated_at: string | null
          newest_at: string | null
          oldest_at: string | null
          row_count: number
          skipped_by: string | null
          skipped_reason: string | null
          status: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          last_evaluated_at?: string | null
          newest_at?: string | null
          oldest_at?: string | null
          row_count?: number
          skipped_by?: string | null
          skipped_reason?: string | null
          status?: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          last_evaluated_at?: string | null
          newest_at?: string | null
          oldest_at?: string | null
          row_count?: number
          skipped_by?: string | null
          skipped_reason?: string | null
          status?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_backfill_progress_skipped_by_fkey"
            columns: ["skipped_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_backfill_progress_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_progress: {
        Row: {
          checklist_item_completed: boolean
          checklist_item_completed_at: string | null
          completed: boolean | null
          completed_at: string | null
          couple_photo_uploaded: boolean
          couple_photo_uploaded_at: string | null
          created_at: string | null
          first_message_sent: boolean
          first_message_sent_at: string | null
          id: string
          inspo_uploaded: boolean
          inspo_uploaded_at: string | null
          step: string | null
          updated_at: string | null
          vendor_added: boolean
          vendor_added_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          checklist_item_completed?: boolean
          checklist_item_completed_at?: string | null
          completed?: boolean | null
          completed_at?: string | null
          couple_photo_uploaded?: boolean
          couple_photo_uploaded_at?: string | null
          created_at?: string | null
          first_message_sent?: boolean
          first_message_sent_at?: string | null
          id?: string
          inspo_uploaded?: boolean
          inspo_uploaded_at?: string | null
          step?: string | null
          updated_at?: string | null
          vendor_added?: boolean
          vendor_added_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          checklist_item_completed?: boolean
          checklist_item_completed_at?: string | null
          completed?: boolean | null
          completed_at?: string | null
          couple_photo_uploaded?: boolean
          couple_photo_uploaded_at?: string | null
          created_at?: string | null
          first_message_sent?: boolean
          first_message_sent_at?: string | null
          id?: string
          inspo_uploaded?: boolean
          inspo_uploaded_at?: string | null
          step?: string | null
          updated_at?: string | null
          vendor_added?: boolean
          vendor_added_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_progress_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_progress_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "onboarding_progress_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_projects: {
        Row: {
          completed_at: string | null
          coordinator_notes: Json
          created_at: string
          current_day: number
          current_step_key: string | null
          day_1_completed_at: string | null
          day_2_completed_at: string | null
          day_3_completed_at: string | null
          day_4_completed_at: string | null
          day_5_completed_at: string | null
          id: string
          readiness_failures: Json
          readiness_passed_at: string | null
          readiness_state: Json
          started_at: string
          status: string
          target_go_live: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          coordinator_notes?: Json
          created_at?: string
          current_day?: number
          current_step_key?: string | null
          day_1_completed_at?: string | null
          day_2_completed_at?: string | null
          day_3_completed_at?: string | null
          day_4_completed_at?: string | null
          day_5_completed_at?: string | null
          id?: string
          readiness_failures?: Json
          readiness_passed_at?: string | null
          readiness_state?: Json
          started_at?: string
          status?: string
          target_go_live?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          coordinator_notes?: Json
          created_at?: string
          current_day?: number
          current_step_key?: string | null
          day_1_completed_at?: string | null
          day_2_completed_at?: string | null
          day_3_completed_at?: string | null
          day_4_completed_at?: string | null
          day_5_completed_at?: string | null
          id?: string
          readiness_failures?: Json
          readiness_passed_at?: string | null
          readiness_state?: Json
          started_at?: string
          status?: string
          target_go_live?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_projects_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      openphone_connections: {
        Row: {
          api_key: string
          created_at: string | null
          id: string
          is_active: boolean | null
          last_synced_at: string | null
          phone_numbers: Json | null
          updated_at: string | null
          venue_id: string
          workspace_label: string | null
        }
        Insert: {
          api_key: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          last_synced_at?: string | null
          phone_numbers?: Json | null
          updated_at?: string | null
          venue_id: string
          workspace_label?: string | null
        }
        Update: {
          api_key?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          last_synced_at?: string | null
          phone_numbers?: Json | null
          updated_at?: string | null
          venue_id?: string
          workspace_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "openphone_connections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      org_essentials_preferences: {
        Row: {
          created_at: string
          default_level: string
          id: string
          org_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          default_level?: string
          id?: string
          org_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          default_level?: string
          id?: string
          org_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_essentials_preferences_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: true
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_essentials_preferences_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organisations: {
        Row: {
          accent_color: string | null
          brand_description: string | null
          created_at: string | null
          id: string
          is_demo: boolean | null
          logo_url: string | null
          name: string
          owner_id: string | null
          plan_tier: string | null
          primary_color: string | null
          secondary_color: string | null
          stripe_customer_id: string | null
        }
        Insert: {
          accent_color?: string | null
          brand_description?: string | null
          created_at?: string | null
          id?: string
          is_demo?: boolean | null
          logo_url?: string | null
          name: string
          owner_id?: string | null
          plan_tier?: string | null
          primary_color?: string | null
          secondary_color?: string | null
          stripe_customer_id?: string | null
        }
        Update: {
          accent_color?: string | null
          brand_description?: string | null
          created_at?: string | null
          id?: string
          is_demo?: boolean | null
          logo_url?: string | null
          name?: string
          owner_id?: string | null
          plan_tier?: string | null
          primary_color?: string | null
          secondary_color?: string | null
          stripe_customer_id?: string | null
        }
        Relationships: []
      }
      packages: {
        Row: {
          confidence_flag: string | null
          created_at: string
          crm_source: string | null
          description: string | null
          discount_percent: number | null
          guest_count_max: number | null
          guest_count_min: number | null
          id: string
          kind: string
          name: string
          notes: string | null
          price_cents: number | null
          season: string | null
          source_text: string | null
          status: string
          tier: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          confidence_flag?: string | null
          created_at?: string
          crm_source?: string | null
          description?: string | null
          discount_percent?: number | null
          guest_count_max?: number | null
          guest_count_min?: number | null
          id?: string
          kind: string
          name: string
          notes?: string | null
          price_cents?: number | null
          season?: string | null
          source_text?: string | null
          status?: string
          tier?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          confidence_flag?: string | null
          created_at?: string
          crm_source?: string | null
          description?: string | null
          discount_percent?: number | null
          guest_count_max?: number | null
          guest_count_min?: number | null
          id?: string
          kind?: string
          name?: string
          notes?: string | null
          price_cents?: number | null
          season?: string | null
          source_text?: string | null
          status?: string
          tier?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "packages_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      paused_period_skipped: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          payload: Json | null
          replay_result: Json | null
          replayed_at: string | null
          scheduled_for: string
          skipped_at: string
          status: string
          venue_id: string
          work_type: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          payload?: Json | null
          replay_result?: Json | null
          replayed_at?: string | null
          scheduled_for: string
          skipped_at?: string
          status?: string
          venue_id: string
          work_type: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          payload?: Json | null
          replay_result?: Json | null
          replayed_at?: string | null
          scheduled_for?: string
          skipped_at?: string
          status?: string
          venue_id?: string
          work_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "paused_period_skipped_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_sms_drafts: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          confidence_0_100: number | null
          correlation_id: string | null
          cost: number | null
          created_at: string | null
          draft_body: string
          id: string
          person_id: string | null
          prompt_version: string | null
          reason: string
          rejected_at: string | null
          rejection_reason: string | null
          sent_at: string | null
          sequence_id: string | null
          sequence_type: string | null
          status: string
          to_phone: string
          tokens_used: number | null
          trigger_interaction_id: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          confidence_0_100?: number | null
          correlation_id?: string | null
          cost?: number | null
          created_at?: string | null
          draft_body: string
          id?: string
          person_id?: string | null
          prompt_version?: string | null
          reason: string
          rejected_at?: string | null
          rejection_reason?: string | null
          sent_at?: string | null
          sequence_id?: string | null
          sequence_type?: string | null
          status?: string
          to_phone: string
          tokens_used?: number | null
          trigger_interaction_id?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          confidence_0_100?: number | null
          correlation_id?: string | null
          cost?: number | null
          created_at?: string | null
          draft_body?: string
          id?: string
          person_id?: string | null
          prompt_version?: string | null
          reason?: string
          rejected_at?: string | null
          rejection_reason?: string | null
          sent_at?: string | null
          sequence_id?: string | null
          sequence_type?: string | null
          status?: string
          to_phone?: string
          tokens_used?: number | null
          trigger_interaction_id?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pending_sms_drafts_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_sms_drafts_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_sms_drafts_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "follow_up_sequences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_sms_drafts_trigger_interaction_id_fkey"
            columns: ["trigger_interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_sms_drafts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_sms_drafts_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "pending_sms_drafts_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          address_label: string | null
          alias_emails: string[]
          city: string | null
          confidence_flag: string | null
          country: string | null
          created_at: string | null
          crm_source: string | null
          display_handle: string | null
          email: string | null
          employer: string | null
          external_ids: Json
          first_name: string | null
          hometown: string | null
          id: string
          last_name: string | null
          merged_into_id: string | null
          name_confidence: number | null
          name_evidence: Json
          name_locked_at: string | null
          name_locked_by: string | null
          name_locked_by_operator: boolean
          partner_role_kind: string | null
          phone: string | null
          platform_handles: Json
          postal_code: string | null
          preferred_contact_channel: string | null
          preferred_contact_channel_set_at: string | null
          preferred_contact_channel_source: string | null
          profile_field_source: Json
          region: string | null
          role: string | null
          street_line_1: string | null
          street_line_2: string | null
          updated_at: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          address_label?: string | null
          alias_emails?: string[]
          city?: string | null
          confidence_flag?: string | null
          country?: string | null
          created_at?: string | null
          crm_source?: string | null
          display_handle?: string | null
          email?: string | null
          employer?: string | null
          external_ids?: Json
          first_name?: string | null
          hometown?: string | null
          id?: string
          last_name?: string | null
          merged_into_id?: string | null
          name_confidence?: number | null
          name_evidence?: Json
          name_locked_at?: string | null
          name_locked_by?: string | null
          name_locked_by_operator?: boolean
          partner_role_kind?: string | null
          phone?: string | null
          platform_handles?: Json
          postal_code?: string | null
          preferred_contact_channel?: string | null
          preferred_contact_channel_set_at?: string | null
          preferred_contact_channel_source?: string | null
          profile_field_source?: Json
          region?: string | null
          role?: string | null
          street_line_1?: string | null
          street_line_2?: string | null
          updated_at?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          address_label?: string | null
          alias_emails?: string[]
          city?: string | null
          confidence_flag?: string | null
          country?: string | null
          created_at?: string | null
          crm_source?: string | null
          display_handle?: string | null
          email?: string | null
          employer?: string | null
          external_ids?: Json
          first_name?: string | null
          hometown?: string | null
          id?: string
          last_name?: string | null
          merged_into_id?: string | null
          name_confidence?: number | null
          name_evidence?: Json
          name_locked_at?: string | null
          name_locked_by?: string | null
          name_locked_by_operator?: boolean
          partner_role_kind?: string | null
          phone?: string | null
          platform_handles?: Json
          postal_code?: string | null
          preferred_contact_channel?: string | null
          preferred_contact_channel_set_at?: string | null
          preferred_contact_channel_source?: string | null
          profile_field_source?: Json
          region?: string | null
          role?: string | null
          street_line_1?: string | null
          street_line_2?: string | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "people_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "people_name_locked_by_fkey"
            columns: ["name_locked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "people_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "people_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "people_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      person_merges: {
        Row: {
          confidence_score: number | null
          id: string
          kept_person_id: string | null
          merged_at: string
          merged_by: string | null
          merged_person_id: string | null
          signals: Json
          snapshot: Json
          tier: string
          undone_at: string | null
          undone_by: string | null
          venue_id: string
        }
        Insert: {
          confidence_score?: number | null
          id?: string
          kept_person_id?: string | null
          merged_at?: string
          merged_by?: string | null
          merged_person_id?: string | null
          signals?: Json
          snapshot?: Json
          tier: string
          undone_at?: string | null
          undone_by?: string | null
          venue_id: string
        }
        Update: {
          confidence_score?: number | null
          id?: string
          kept_person_id?: string | null
          merged_at?: string
          merged_by?: string | null
          merged_person_id?: string | null
          signals?: Json
          snapshot?: Json
          tier?: string
          undone_at?: string | null
          undone_by?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_merges_kept_person_id_fkey"
            columns: ["kept_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_merges_merged_by_fkey"
            columns: ["merged_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_merges_undone_by_fkey"
            columns: ["undone_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_merges_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      persona_channel_rollups: {
        Row: {
          avg_booking_value_cents: number | null
          booked_count: number
          cac_cents: number | null
          channel: string
          computed_at: string
          conversion_pct: number | null
          id: string
          inquiries_count: number
          lost_count: number
          ltv_cents: number | null
          n_too_small: boolean
          payback_months: number | null
          persona_label: string | null
          roi_pct: number | null
          spend_cents: number
          time_window_end: string
          time_window_start: string
          total_booked_value_cents: number
          touring_count: number
          venue_id: string
        }
        Insert: {
          avg_booking_value_cents?: number | null
          booked_count?: number
          cac_cents?: number | null
          channel: string
          computed_at?: string
          conversion_pct?: number | null
          id?: string
          inquiries_count?: number
          lost_count?: number
          ltv_cents?: number | null
          n_too_small?: boolean
          payback_months?: number | null
          persona_label?: string | null
          roi_pct?: number | null
          spend_cents?: number
          time_window_end: string
          time_window_start: string
          total_booked_value_cents?: number
          touring_count?: number
          venue_id: string
        }
        Update: {
          avg_booking_value_cents?: number | null
          booked_count?: number
          cac_cents?: number | null
          channel?: string
          computed_at?: string
          conversion_pct?: number | null
          id?: string
          inquiries_count?: number
          lost_count?: number
          ltv_cents?: number | null
          n_too_small?: boolean
          payback_months?: number | null
          persona_label?: string | null
          roi_pct?: number | null
          spend_cents?: number
          time_window_end?: string
          time_window_start?: string
          total_booked_value_cents?: number
          touring_count?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "persona_channel_rollups_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      photo_library: {
        Row: {
          caption: string | null
          created_at: string | null
          id: string
          image_url: string
          is_hero: boolean | null
          is_website: boolean | null
          people_tags: string[] | null
          tags: string[] | null
          uploaded_by: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          id?: string
          image_url: string
          is_hero?: boolean | null
          is_website?: boolean | null
          people_tags?: string[] | null
          tags?: string[] | null
          uploaded_by?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          id?: string
          image_url?: string
          is_hero?: boolean | null
          is_website?: boolean | null
          people_tags?: string[] | null
          tags?: string[] | null
          uploaded_by?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "photo_library_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photo_library_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photo_library_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "photo_library_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      phrase_usage: {
        Row: {
          confidence_flag: string | null
          contact_email: string | null
          id: string
          phrase_category: string
          phrase_text: string
          used_at: string | null
          venue_id: string
        }
        Insert: {
          confidence_flag?: string | null
          contact_email?: string | null
          id?: string
          phrase_category: string
          phrase_text: string
          used_at?: string | null
          venue_id: string
        }
        Update: {
          confidence_flag?: string | null
          contact_email?: string | null
          id?: string
          phrase_category?: string
          phrase_text?: string
          used_at?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "phrase_usage_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      planning_notes: {
        Row: {
          category: string | null
          content: string
          created_at: string | null
          id: string
          source_channel: string | null
          source_interaction_id: string | null
          source_message: string | null
          status: string | null
          user_id: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          category?: string | null
          content: string
          created_at?: string | null
          id?: string
          source_channel?: string | null
          source_interaction_id?: string | null
          source_message?: string | null
          status?: string | null
          user_id?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          category?: string | null
          content?: string
          created_at?: string | null
          id?: string
          source_channel?: string | null
          source_interaction_id?: string | null
          source_message?: string | null
          status?: string | null
          user_id?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "planning_notes_source_interaction_id_fkey"
            columns: ["source_interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planning_notes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planning_notes_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "planning_notes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "planning_notes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_configs: {
        Row: {
          created_at: string
          followers_url: string | null
          id: string
          is_active: boolean
          platform: string
          recommended_frequency_days: number | null
          updated_at: string
          venue_handle: string | null
          venue_id: string
        }
        Insert: {
          created_at?: string
          followers_url?: string | null
          id?: string
          is_active?: boolean
          platform: string
          recommended_frequency_days?: number | null
          updated_at?: string
          venue_handle?: string | null
          venue_id: string
        }
        Update: {
          created_at?: string
          followers_url?: string | null
          id?: string
          is_active?: boolean
          platform?: string
          recommended_frequency_days?: number | null
          updated_at?: string
          venue_handle?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_configs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_section_config: {
        Row: {
          created_at: string | null
          description: string | null
          icon: string | null
          id: string
          label: string
          section_key: string
          sort_order: number | null
          updated_at: string | null
          venue_id: string
          visibility: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          label: string
          section_key: string
          sort_order?: number | null
          updated_at?: string | null
          venue_id: string
          visibility?: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          icon?: string | null
          id?: string
          label?: string
          section_key?: string
          sort_order?: number | null
          updated_at?: string | null
          venue_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "portal_section_config_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      post_tour_followup_jobs: {
        Row: {
          completed_at: string | null
          draft_id: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          tour_id: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          completed_at?: string | null
          draft_id?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          tour_id: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          completed_at?: string | null
          draft_id?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          tour_id?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "post_tour_followup_jobs_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_tour_followup_jobs_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_tour_followup_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_tour_followup_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "post_tour_followup_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      post_tour_sequence: {
        Row: {
          completed_reason: string | null
          created_at: string
          email_1_draft_id: string | null
          email_1_sent_at: string | null
          email_2_draft_id: string | null
          email_2_sent_at: string | null
          email_3_draft_id: string | null
          email_3_sent_at: string | null
          id: string
          paused_at: string | null
          paused_reason: string | null
          sequence_completed_at: string | null
          tour_completed_at: string
          tour_id: string | null
          updated_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          completed_reason?: string | null
          created_at?: string
          email_1_draft_id?: string | null
          email_1_sent_at?: string | null
          email_2_draft_id?: string | null
          email_2_sent_at?: string | null
          email_3_draft_id?: string | null
          email_3_sent_at?: string | null
          id?: string
          paused_at?: string | null
          paused_reason?: string | null
          sequence_completed_at?: string | null
          tour_completed_at: string
          tour_id?: string | null
          updated_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          completed_reason?: string | null
          created_at?: string
          email_1_draft_id?: string | null
          email_1_sent_at?: string | null
          email_2_draft_id?: string | null
          email_2_sent_at?: string | null
          email_3_draft_id?: string | null
          email_3_sent_at?: string | null
          id?: string
          paused_at?: string | null
          paused_reason?: string | null
          sequence_completed_at?: string | null
          tour_completed_at?: string
          tour_id?: string | null
          updated_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_tour_sequence_email_1_draft_id_fkey"
            columns: ["email_1_draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_tour_sequence_email_2_draft_id_fkey"
            columns: ["email_2_draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_tour_sequence_email_3_draft_id_fkey"
            columns: ["email_3_draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_tour_sequence_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_tour_sequence_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_tour_sequence_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "post_tour_sequence_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_outcomes: {
        Row: {
          actual_outcome: Json | null
          error_magnitude: number | null
          id: string
          matched_prediction: boolean | null
          measured_at: string
          prediction_snapshot_id: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          actual_outcome?: Json | null
          error_magnitude?: number | null
          id?: string
          matched_prediction?: boolean | null
          measured_at?: string
          prediction_snapshot_id?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          actual_outcome?: Json | null
          error_magnitude?: number | null
          id?: string
          matched_prediction?: boolean | null
          measured_at?: string
          prediction_snapshot_id?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_outcomes_prediction_snapshot_id_fkey"
            columns: ["prediction_snapshot_id"]
            isOneToOne: false
            referencedRelation: "prediction_snapshots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_outcomes_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_outcomes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "prediction_outcomes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      prediction_snapshots: {
        Row: {
          cost_cents: number | null
          id: string
          predicted_confidence_0_100: number | null
          predicted_value: Json
          prediction_kind: string
          prediction_source: string | null
          prompt_version: string | null
          snapshotted_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          cost_cents?: number | null
          id?: string
          predicted_confidence_0_100?: number | null
          predicted_value: Json
          prediction_kind: string
          prediction_source?: string | null
          prompt_version?: string | null
          snapshotted_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          cost_cents?: number | null
          id?: string
          predicted_confidence_0_100?: number | null
          predicted_value?: Json
          prediction_kind?: string
          prediction_source?: string | null
          prompt_version?: string | null
          snapshotted_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prediction_snapshots_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prediction_snapshots_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "prediction_snapshots_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          confidence_flag: string | null
          context: string | null
          field_name: string
          id: string
          new_value: Json | null
          notes: string | null
          old_value: Json | null
          source_provenance: string | null
          venue_id: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          confidence_flag?: string | null
          context?: string | null
          field_name: string
          id?: string
          new_value?: Json | null
          notes?: string | null
          old_value?: Json | null
          source_provenance?: string | null
          venue_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          confidence_flag?: string | null
          context?: string | null
          field_name?: string
          id?: string
          new_value?: Json | null
          notes?: string | null
          old_value?: Json | null
          source_provenance?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pricing_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pricing_history_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      processed_sms_messages: {
        Row: {
          body_text: string | null
          channel: string | null
          direction: string | null
          from_number: string | null
          id: string
          occurred_at: string | null
          openphone_message_id: string
          processed_at: string | null
          to_number: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          body_text?: string | null
          channel?: string | null
          direction?: string | null
          from_number?: string | null
          id?: string
          occurred_at?: string | null
          openphone_message_id: string
          processed_at?: string | null
          to_number?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          body_text?: string | null
          channel?: string | null
          direction?: string | null
          from_number?: string | null
          id?: string
          occurred_at?: string | null
          openphone_message_id?: string
          processed_at?: string | null
          to_number?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "processed_sms_messages_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processed_sms_messages_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "processed_sms_messages_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      processed_zoom_meetings: {
        Row: {
          duration_minutes: number | null
          id: string
          meeting_start_time: string | null
          meeting_topic: string | null
          participant_names: string[] | null
          processed_at: string | null
          recording_urls: Json | null
          transcript_text: string | null
          venue_id: string
          wedding_id: string | null
          zoom_meeting_id: string
          zoom_meeting_uuid: string | null
        }
        Insert: {
          duration_minutes?: number | null
          id?: string
          meeting_start_time?: string | null
          meeting_topic?: string | null
          participant_names?: string[] | null
          processed_at?: string | null
          recording_urls?: Json | null
          transcript_text?: string | null
          venue_id: string
          wedding_id?: string | null
          zoom_meeting_id: string
          zoom_meeting_uuid?: string | null
        }
        Update: {
          duration_minutes?: number | null
          id?: string
          meeting_start_time?: string | null
          meeting_topic?: string | null
          participant_names?: string[] | null
          processed_at?: string | null
          recording_urls?: Json | null
          transcript_text?: string | null
          venue_id?: string
          wedding_id?: string | null
          zoom_meeting_id?: string
          zoom_meeting_uuid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "processed_zoom_meetings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processed_zoom_meetings_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "processed_zoom_meetings_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_enrichment_runs: {
        Row: {
          correlation_id: string | null
          cost_cents: number | null
          created_at: string
          error: string | null
          fields_updated_count: number
          id: string
          notes_added_count: number
          prompt_version: string | null
          scanned_count: number
          trigger: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          correlation_id?: string | null
          cost_cents?: number | null
          created_at?: string
          error?: string | null
          fields_updated_count?: number
          id?: string
          notes_added_count?: number
          prompt_version?: string | null
          scanned_count?: number
          trigger: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          correlation_id?: string | null
          cost_cents?: number | null
          created_at?: string
          error?: string | null
          fields_updated_count?: number
          id?: string
          notes_added_count?: number
          prompt_version?: string | null
          scanned_count?: number
          trigger?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_enrichment_runs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_enrichment_runs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "profile_enrichment_runs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      pulse_snoozes: {
        Row: {
          action: string
          created_at: string
          id: string
          item_key: string
          reason: string | null
          snoozed_until: string | null
          user_id: string | null
          venue_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          item_key: string
          reason?: string | null
          snoozed_until?: string | null
          user_id?: string | null
          venue_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          item_key?: string
          reason?: string | null
          snoozed_until?: string | null
          user_id?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pulse_snoozes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pulse_snoozes_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_buckets: {
        Row: {
          hits: Json
          key: string
          updated_at: string
          window_start: string
        }
        Insert: {
          hits?: Json
          key: string
          updated_at?: string
          window_start?: string
        }
        Update: {
          hits?: Json
          key?: string
          updated_at?: string
          window_start?: string
        }
        Relationships: []
      }
      re_engagement_actions: {
        Row: {
          candidate_identity_id: string
          channel: string | null
          conversion_detected_at: string | null
          conversion_inquiry_channel: string | null
          conversion_wedding_id: string | null
          created_at: string
          draft_text: string
          drafted_at: string
          drafted_by_model: string | null
          id: string
          platform: string
          sent_at: string | null
          sent_by: string | null
          sent_text: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          candidate_identity_id: string
          channel?: string | null
          conversion_detected_at?: string | null
          conversion_inquiry_channel?: string | null
          conversion_wedding_id?: string | null
          created_at?: string
          draft_text: string
          drafted_at?: string
          drafted_by_model?: string | null
          id?: string
          platform: string
          sent_at?: string | null
          sent_by?: string | null
          sent_text?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          candidate_identity_id?: string
          channel?: string | null
          conversion_detected_at?: string | null
          conversion_inquiry_channel?: string | null
          conversion_wedding_id?: string | null
          created_at?: string
          draft_text?: string
          drafted_at?: string
          drafted_by_model?: string | null
          id?: string
          platform?: string
          sent_at?: string | null
          sent_by?: string | null
          sent_text?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "re_engagement_actions_candidate_identity_id_fkey"
            columns: ["candidate_identity_id"]
            isOneToOne: false
            referencedRelation: "candidate_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "re_engagement_actions_conversion_wedding_id_fkey"
            columns: ["conversion_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "re_engagement_actions_conversion_wedding_id_fkey"
            columns: ["conversion_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "re_engagement_actions_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "re_engagement_actions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_extraction_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          result_summary: Json | null
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          result_summary?: Json | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          result_summary?: Json | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_extraction_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_extraction_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "referral_extraction_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      rehearsal_dinner: {
        Row: {
          address: string | null
          created_at: string | null
          date: string | null
          end_time: string | null
          guest_count: number | null
          id: string
          location_name: string | null
          menu_notes: string | null
          special_arrangements: string | null
          start_time: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          address?: string | null
          created_at?: string | null
          date?: string | null
          end_time?: string | null
          guest_count?: number | null
          id?: string
          location_name?: string | null
          menu_notes?: string | null
          special_arrangements?: string | null
          start_time?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          address?: string | null
          created_at?: string | null
          date?: string | null
          end_time?: string | null
          guest_count?: number | null
          id?: string
          location_name?: string | null
          menu_notes?: string | null
          special_arrangements?: string | null
          start_time?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rehearsal_dinner_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rehearsal_dinner_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "rehearsal_dinner_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      relationships: {
        Row: {
          created_at: string | null
          id: string
          notes: string | null
          person_a_id: string | null
          person_b_id: string | null
          relationship_type: string | null
          venue_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          notes?: string | null
          person_a_id?: string | null
          person_b_id?: string | null
          relationship_type?: string | null
          venue_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          notes?: string | null
          person_a_id?: string | null
          person_b_id?: string | null
          relationship_type?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "relationships_person_a_id_fkey"
            columns: ["person_a_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "relationships_person_b_id_fkey"
            columns: ["person_b_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "relationships_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      resurrection_blacklist: {
        Row: {
          couple_id: string
          created_at: string
          id: string
          identifier: string
          identifier_kind: string
          operator_id: string | null
          reason: string | null
          venue_id: string
        }
        Insert: {
          couple_id: string
          created_at?: string
          id?: string
          identifier: string
          identifier_kind: string
          operator_id?: string | null
          reason?: string | null
          venue_id: string
        }
        Update: {
          couple_id?: string
          created_at?: string
          id?: string
          identifier?: string
          identifier_kind?: string
          operator_id?: string | null
          reason?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "resurrection_blacklist_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resurrection_blacklist_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      review_language: {
        Row: {
          approved_for_marketing: boolean | null
          approved_for_sage: boolean | null
          confidence_flag: string | null
          created_at: string | null
          frequency: number | null
          id: string
          phrase: string
          sentiment_score: number | null
          source_reference: string | null
          source_type: string | null
          theme: string | null
          venue_id: string
        }
        Insert: {
          approved_for_marketing?: boolean | null
          approved_for_sage?: boolean | null
          confidence_flag?: string | null
          created_at?: string | null
          frequency?: number | null
          id?: string
          phrase: string
          sentiment_score?: number | null
          source_reference?: string | null
          source_type?: string | null
          theme?: string | null
          venue_id: string
        }
        Update: {
          approved_for_marketing?: boolean | null
          approved_for_sage?: boolean | null
          confidence_flag?: string | null
          created_at?: string | null
          frequency?: number | null
          id?: string
          phrase?: string
          sentiment_score?: number | null
          source_reference?: string | null
          source_type?: string | null
          theme?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_language_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      review_match_review_queue: {
        Row: {
          candidates: Json
          created_at: string
          defer_reason: string
          id: string
          resolution: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_wedding_id: string | null
          review_id: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          candidates?: Json
          created_at?: string
          defer_reason: string
          id?: string
          resolution?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_wedding_id?: string | null
          review_id: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          candidates?: Json
          created_at?: string
          defer_reason?: string
          id?: string
          resolution?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_wedding_id?: string | null
          review_id?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_match_review_queue_resolved_wedding_id_fkey"
            columns: ["resolved_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "review_match_review_queue_resolved_wedding_id_fkey"
            columns: ["resolved_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_match_review_queue_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_match_review_queue_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      review_solicit_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          request_id: string | null
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          request_id?: string | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          request_id?: string | null
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_solicit_jobs_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "review_solicit_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_solicit_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_solicit_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "review_solicit_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      review_solicit_requests: {
        Row: {
          body: string | null
          cost_cents: number
          draft_id: string | null
          generated_at: string
          id: string
          prompt_version: string | null
          response_received_at: string | null
          review_id: string | null
          review_link_url: string | null
          sent_at: string | null
          status: string
          subject: string | null
          target_channel: string
          tour_id: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          body?: string | null
          cost_cents?: number
          draft_id?: string | null
          generated_at?: string
          id?: string
          prompt_version?: string | null
          response_received_at?: string | null
          review_id?: string | null
          review_link_url?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          target_channel: string
          tour_id?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          body?: string | null
          cost_cents?: number
          draft_id?: string | null
          generated_at?: string
          id?: string
          prompt_version?: string | null
          response_received_at?: string | null
          review_id?: string | null
          review_link_url?: string | null
          sent_at?: string | null
          status?: string
          subject?: string | null
          target_channel?: string
          tour_id?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_solicit_requests_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_solicit_requests_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_solicit_requests_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_solicit_requests_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_solicit_requests_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "review_solicit_requests_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          body: string
          created_at: string | null
          id: string
          is_featured: boolean | null
          rating: number
          raw_import_row: Json | null
          response_date: string | null
          response_text: string | null
          review_date: string
          reviewer_name: string | null
          sentiment_score: number | null
          source: string
          source_review_id: string | null
          themes: string[] | null
          title: string | null
          updated_at: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          body: string
          created_at?: string | null
          id?: string
          is_featured?: boolean | null
          rating: number
          raw_import_row?: Json | null
          response_date?: string | null
          response_text?: string | null
          review_date: string
          reviewer_name?: string | null
          sentiment_score?: number | null
          source: string
          source_review_id?: string | null
          themes?: string[] | null
          title?: string | null
          updated_at?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          body?: string
          created_at?: string | null
          id?: string
          is_featured?: boolean | null
          rating?: number
          raw_import_row?: Json | null
          response_date?: string | null
          response_text?: string | null
          review_date?: string
          reviewer_name?: string | null
          sentiment_score?: number | null
          source?: string
          source_review_id?: string | null
          themes?: string[] | null
          title?: string | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reviews_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "reviews_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      rsvp_config: {
        Row: {
          allow_maybe: boolean | null
          ask_accessibility: boolean | null
          ask_address: boolean | null
          ask_allergies: boolean | null
          ask_dietary: boolean | null
          ask_email: boolean | null
          ask_hotel: boolean | null
          ask_meal_choice: boolean | null
          ask_message: boolean | null
          ask_phone: boolean | null
          ask_shuttle: boolean | null
          ask_song_request: boolean | null
          attending_message: string | null
          created_at: string | null
          custom_questions: Json | null
          declined_message: string | null
          id: string
          rsvp_deadline: string | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          allow_maybe?: boolean | null
          ask_accessibility?: boolean | null
          ask_address?: boolean | null
          ask_allergies?: boolean | null
          ask_dietary?: boolean | null
          ask_email?: boolean | null
          ask_hotel?: boolean | null
          ask_meal_choice?: boolean | null
          ask_message?: boolean | null
          ask_phone?: boolean | null
          ask_shuttle?: boolean | null
          ask_song_request?: boolean | null
          attending_message?: string | null
          created_at?: string | null
          custom_questions?: Json | null
          declined_message?: string | null
          id?: string
          rsvp_deadline?: string | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          allow_maybe?: boolean | null
          ask_accessibility?: boolean | null
          ask_address?: boolean | null
          ask_allergies?: boolean | null
          ask_dietary?: boolean | null
          ask_email?: boolean | null
          ask_hotel?: boolean | null
          ask_meal_choice?: boolean | null
          ask_message?: boolean | null
          ask_phone?: boolean | null
          ask_shuttle?: boolean | null
          ask_song_request?: boolean | null
          attending_message?: string | null
          created_at?: string | null
          custom_questions?: Json | null
          declined_message?: string | null
          id?: string
          rsvp_deadline?: string | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rsvp_config_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rsvp_config_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "rsvp_config_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      rsvp_responses: {
        Row: {
          accessibility_needs: string | null
          address: string | null
          allergies: string | null
          created_at: string | null
          custom_answers: Json | null
          email: string | null
          guest_id: string
          hotel_name: string | null
          id: string
          message_to_couple: string | null
          phone: string | null
          responded_at: string | null
          shuttle_needed: boolean | null
          song_request: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          accessibility_needs?: string | null
          address?: string | null
          allergies?: string | null
          created_at?: string | null
          custom_answers?: Json | null
          email?: string | null
          guest_id: string
          hotel_name?: string | null
          id?: string
          message_to_couple?: string | null
          phone?: string | null
          responded_at?: string | null
          shuttle_needed?: boolean | null
          song_request?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          accessibility_needs?: string | null
          address?: string | null
          allergies?: string | null
          created_at?: string | null
          custom_answers?: Json | null
          email?: string | null
          guest_id?: string
          hotel_name?: string | null
          id?: string
          message_to_couple?: string | null
          phone?: string | null
          responded_at?: string | null
          shuttle_needed?: boolean | null
          song_request?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rsvp_responses_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guest_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rsvp_responses_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rsvp_responses_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "rsvp_responses_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      sage_conversations: {
        Row: {
          confidence_score: number | null
          content: string
          cost: number | null
          created_at: string | null
          flagged_uncertain: boolean | null
          id: string
          model_used: string | null
          role: string
          tokens_used: number | null
          user_id: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          confidence_score?: number | null
          content: string
          cost?: number | null
          created_at?: string | null
          flagged_uncertain?: boolean | null
          id?: string
          model_used?: string | null
          role: string
          tokens_used?: number | null
          user_id?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          confidence_score?: number | null
          content?: string
          cost?: number | null
          created_at?: string | null
          flagged_uncertain?: boolean | null
          id?: string
          model_used?: string | null
          role?: string
          tokens_used?: number | null
          user_id?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sage_conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sage_conversations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sage_conversations_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "sage_conversations_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      sage_uncertain_queue: {
        Row: {
          added_to_kb: boolean | null
          confidence_score: number | null
          conversation_id: string | null
          coordinator_response: string | null
          created_at: string | null
          id: string
          question: string
          reason: string
          resolved_at: string | null
          resolved_by: string | null
          sage_answer: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          added_to_kb?: boolean | null
          confidence_score?: number | null
          conversation_id?: string | null
          coordinator_response?: string | null
          created_at?: string | null
          id?: string
          question: string
          reason?: string
          resolved_at?: string | null
          resolved_by?: string | null
          sage_answer?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          added_to_kb?: boolean | null
          confidence_score?: number | null
          conversation_id?: string | null
          coordinator_response?: string | null
          created_at?: string | null
          id?: string
          question?: string
          reason?: string
          resolved_at?: string | null
          resolved_by?: string | null
          sage_answer?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sage_uncertain_queue_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "sage_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sage_uncertain_queue_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sage_uncertain_queue_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sage_uncertain_queue_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "sage_uncertain_queue_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      search_trends: {
        Row: {
          created_at: string | null
          id: string
          interest: number | null
          metro: string | null
          term: string
          venue_id: string
          week: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          interest?: number | null
          metro?: string | null
          term: string
          venue_id: string
          week: string
        }
        Update: {
          created_at?: string | null
          id?: string
          interest?: number | null
          metro?: string | null
          term?: string
          venue_id?: string
          week?: string
        }
        Relationships: [
          {
            foreignKeyName: "search_trends_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      seating_tables: {
        Row: {
          capacity: number | null
          created_at: string | null
          id: string
          notes: string | null
          rotation: number | null
          sort_order: number | null
          table_name: string | null
          table_type: string | null
          venue_id: string
          wedding_id: string
          x_position: number | null
          y_position: number | null
        }
        Insert: {
          capacity?: number | null
          created_at?: string | null
          id?: string
          notes?: string | null
          rotation?: number | null
          sort_order?: number | null
          table_name?: string | null
          table_type?: string | null
          venue_id: string
          wedding_id: string
          x_position?: number | null
          y_position?: number | null
        }
        Update: {
          capacity?: number | null
          created_at?: string | null
          id?: string
          notes?: string | null
          rotation?: number | null
          sort_order?: number | null
          table_name?: string | null
          table_type?: string | null
          venue_id?: string
          wedding_id?: string
          x_position?: number | null
          y_position?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "seating_tables_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seating_tables_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "seating_tables_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      section_finalisations: {
        Row: {
          couple_signed_off: boolean | null
          couple_signed_off_at: string | null
          couple_signed_off_by: string | null
          created_at: string | null
          id: string
          section_name: string
          staff_signed_off: boolean | null
          staff_signed_off_at: string | null
          staff_signed_off_by: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          couple_signed_off?: boolean | null
          couple_signed_off_at?: string | null
          couple_signed_off_by?: string | null
          created_at?: string | null
          id?: string
          section_name: string
          staff_signed_off?: boolean | null
          staff_signed_off_at?: string | null
          staff_signed_off_by?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          couple_signed_off?: boolean | null
          couple_signed_off_at?: string | null
          couple_signed_off_by?: string | null
          created_at?: string | null
          id?: string
          section_name?: string
          staff_signed_off?: boolean | null
          staff_signed_off_at?: string | null
          staff_signed_off_by?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "section_finalisations_couple_signed_off_by_fkey"
            columns: ["couple_signed_off_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_finalisations_staff_signed_off_by_fkey"
            columns: ["staff_signed_off_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_finalisations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "section_finalisations_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "section_finalisations_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_steps: {
        Row: {
          action_type: string
          created_at: string | null
          delay_days: number
          email_body_template: string | null
          email_subject_template: string | null
          id: string
          is_active: boolean | null
          sequence_id: string
          step_order: number
        }
        Insert: {
          action_type: string
          created_at?: string | null
          delay_days?: number
          email_body_template?: string | null
          email_subject_template?: string | null
          id?: string
          is_active?: boolean | null
          sequence_id: string
          step_order: number
        }
        Update: {
          action_type?: string
          created_at?: string | null
          delay_days?: number
          email_body_template?: string | null
          email_subject_template?: string | null
          id?: string
          is_active?: boolean | null
          sequence_id?: string
          step_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "sequence_steps_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "follow_up_sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      shuttle_schedule: {
        Row: {
          capacity: number | null
          created_at: string | null
          departure_time: string | null
          dropoff_location: string | null
          dropoff_time: string | null
          id: string
          notes: string | null
          pickup_location: string | null
          pickup_time: string | null
          route_name: string | null
          run_label: string | null
          seat_count: number | null
          shuttle_id: string | null
          sort_order: number | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          capacity?: number | null
          created_at?: string | null
          departure_time?: string | null
          dropoff_location?: string | null
          dropoff_time?: string | null
          id?: string
          notes?: string | null
          pickup_location?: string | null
          pickup_time?: string | null
          route_name?: string | null
          run_label?: string | null
          seat_count?: number | null
          shuttle_id?: string | null
          sort_order?: number | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          capacity?: number | null
          created_at?: string | null
          departure_time?: string | null
          dropoff_location?: string | null
          dropoff_time?: string | null
          id?: string
          notes?: string | null
          pickup_location?: string | null
          pickup_time?: string | null
          route_name?: string | null
          run_label?: string | null
          seat_count?: number | null
          shuttle_id?: string | null
          sort_order?: number | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shuttle_schedule_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shuttle_schedule_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "shuttle_schedule_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      social_captures: {
        Row: {
          capture_window_end: string | null
          capture_window_start: string | null
          captured_at: string
          captured_by: string | null
          id: string
          matched_count: number | null
          metric_type: string
          parse_result: Json | null
          platform: string
          source_image_path: string | null
          source_text: string | null
          target_metadata: Json
          total_handles: number | null
          unmatched_count: number | null
          venue_id: string
        }
        Insert: {
          capture_window_end?: string | null
          capture_window_start?: string | null
          captured_at?: string
          captured_by?: string | null
          id?: string
          matched_count?: number | null
          metric_type: string
          parse_result?: Json | null
          platform: string
          source_image_path?: string | null
          source_text?: string | null
          target_metadata?: Json
          total_handles?: number | null
          unmatched_count?: number | null
          venue_id: string
        }
        Update: {
          capture_window_end?: string | null
          capture_window_start?: string | null
          captured_at?: string
          captured_by?: string | null
          id?: string
          matched_count?: number | null
          metric_type?: string
          parse_result?: Json | null
          platform?: string
          source_image_path?: string | null
          source_text?: string | null
          target_metadata?: Json
          total_handles?: number | null
          unmatched_count?: number | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_captures_captured_by_fkey"
            columns: ["captured_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_captures_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      social_engagements: {
        Row: {
          couple_id: string | null
          created_at: string
          display_name: string | null
          engagement_at: string | null
          handle: string
          id: string
          match_confidence: number | null
          match_method: string | null
          match_status: string
          matched_at: string | null
          matched_person_id: string | null
          metric_type: string
          platform: string
          post_id: string | null
          social_capture_id: string
          venue_id: string
        }
        Insert: {
          couple_id?: string | null
          created_at?: string
          display_name?: string | null
          engagement_at?: string | null
          handle: string
          id?: string
          match_confidence?: number | null
          match_method?: string | null
          match_status?: string
          matched_at?: string | null
          matched_person_id?: string | null
          metric_type: string
          platform: string
          post_id?: string | null
          social_capture_id: string
          venue_id: string
        }
        Update: {
          couple_id?: string | null
          created_at?: string
          display_name?: string | null
          engagement_at?: string | null
          handle?: string
          id?: string
          match_confidence?: number | null
          match_method?: string | null
          match_status?: string
          matched_at?: string | null
          matched_person_id?: string | null
          metric_type?: string
          platform?: string
          post_id?: string | null
          social_capture_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_engagements_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_engagements_matched_person_id_fkey"
            columns: ["matched_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_engagements_social_capture_id_fkey"
            columns: ["social_capture_id"]
            isOneToOne: false
            referencedRelation: "social_captures"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_engagements_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      social_metrics_config: {
        Row: {
          capture_method: string
          created_at: string
          description: string | null
          id: string
          is_functional: boolean
          label: string
          metric_type: string
          platform: string
          primary_identifier: string
          recommended_frequency_days: number
          required_inputs: Json
          sort_order: number
          updated_at: string
        }
        Insert: {
          capture_method: string
          created_at?: string
          description?: string | null
          id?: string
          is_functional?: boolean
          label: string
          metric_type: string
          platform: string
          primary_identifier?: string
          recommended_frequency_days?: number
          required_inputs?: Json
          sort_order?: number
          updated_at?: string
        }
        Update: {
          capture_method?: string
          created_at?: string
          description?: string | null
          id?: string
          is_functional?: boolean
          label?: string
          metric_type?: string
          platform?: string
          primary_identifier?: string
          recommended_frequency_days?: number
          required_inputs?: Json
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      social_posts: {
        Row: {
          caption: string | null
          comments: number | null
          created_at: string | null
          engagement_rate: number | null
          id: string
          impressions: number | null
          is_viral: boolean | null
          likes: number | null
          platform: string | null
          post_url: string | null
          posted_at: string | null
          profile_visits: number | null
          reach: number | null
          saves: number | null
          shares: number | null
          venue_id: string
          website_clicks: number | null
        }
        Insert: {
          caption?: string | null
          comments?: number | null
          created_at?: string | null
          engagement_rate?: number | null
          id?: string
          impressions?: number | null
          is_viral?: boolean | null
          likes?: number | null
          platform?: string | null
          post_url?: string | null
          posted_at?: string | null
          profile_visits?: number | null
          reach?: number | null
          saves?: number | null
          shares?: number | null
          venue_id: string
          website_clicks?: number | null
        }
        Update: {
          caption?: string | null
          comments?: number | null
          created_at?: string | null
          engagement_rate?: number | null
          id?: string
          impressions?: number | null
          is_viral?: boolean | null
          likes?: number | null
          platform?: string | null
          post_url?: string | null
          posted_at?: string | null
          profile_visits?: number | null
          reach?: number | null
          saves?: number | null
          shares?: number | null
          venue_id?: string
          website_clicks?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "social_posts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      source_attribution: {
        Row: {
          bookings: number | null
          calculated_at: string | null
          conversion_rate: number | null
          cost_per_booking: number | null
          cost_per_inquiry: number | null
          id: string
          inquiries: number | null
          period_end: string
          period_start: string
          revenue: number | null
          roi: number | null
          source: string
          spend: number | null
          tours: number | null
          venue_id: string
        }
        Insert: {
          bookings?: number | null
          calculated_at?: string | null
          conversion_rate?: number | null
          cost_per_booking?: number | null
          cost_per_inquiry?: number | null
          id?: string
          inquiries?: number | null
          period_end: string
          period_start: string
          revenue?: number | null
          roi?: number | null
          source: string
          spend?: number | null
          tours?: number | null
          venue_id: string
        }
        Update: {
          bookings?: number | null
          calculated_at?: string | null
          conversion_rate?: number | null
          cost_per_booking?: number | null
          cost_per_inquiry?: number | null
          id?: string
          inquiries?: number | null
          period_end?: string
          period_start?: string
          revenue?: number | null
          roi?: number | null
          source?: string
          spend?: number | null
          tours?: number | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_attribution_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      staffing_assignments: {
        Row: {
          answers: Json | null
          count: number | null
          created_at: string | null
          friday_bartenders: number | null
          friday_extra_hands: number | null
          friday_total: number | null
          hourly_rate: number | null
          hours: number | null
          id: string
          notes: string | null
          person_name: string | null
          role: string | null
          saturday_bartenders: number | null
          saturday_extra_hands: number | null
          saturday_total: number | null
          tip_amount: number | null
          total_cost: number | null
          total_staff: number | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          answers?: Json | null
          count?: number | null
          created_at?: string | null
          friday_bartenders?: number | null
          friday_extra_hands?: number | null
          friday_total?: number | null
          hourly_rate?: number | null
          hours?: number | null
          id?: string
          notes?: string | null
          person_name?: string | null
          role?: string | null
          saturday_bartenders?: number | null
          saturday_extra_hands?: number | null
          saturday_total?: number | null
          tip_amount?: number | null
          total_cost?: number | null
          total_staff?: number | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          answers?: Json | null
          count?: number | null
          created_at?: string | null
          friday_bartenders?: number | null
          friday_extra_hands?: number | null
          friday_total?: number | null
          hourly_rate?: number | null
          hours?: number | null
          id?: string
          notes?: string | null
          person_name?: string | null
          role?: string | null
          saturday_bartenders?: number | null
          saturday_extra_hands?: number | null
          saturday_total?: number | null
          tip_amount?: number | null
          total_cost?: number | null
          total_staff?: number | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staffing_assignments_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staffing_assignments_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "staffing_assignments_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      staffing_calculator: {
        Row: {
          answers: Json | null
          created_at: string | null
          friday_bartenders: number | null
          friday_extra_hands: number | null
          friday_total: number | null
          id: string
          saturday_bartenders: number | null
          saturday_extra_hands: number | null
          saturday_total: number | null
          total_cost: number | null
          total_staff: number | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          answers?: Json | null
          created_at?: string | null
          friday_bartenders?: number | null
          friday_extra_hands?: number | null
          friday_total?: number | null
          id?: string
          saturday_bartenders?: number | null
          saturday_extra_hands?: number | null
          saturday_total?: number | null
          total_cost?: number | null
          total_staff?: number | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          answers?: Json | null
          created_at?: string | null
          friday_bartenders?: number | null
          friday_extra_hands?: number | null
          friday_total?: number | null
          id?: string
          saturday_bartenders?: number | null
          saturday_extra_hands?: number | null
          saturday_total?: number | null
          total_cost?: number | null
          total_staff?: number | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staffing_calculator_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staffing_calculator_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "staffing_calculator_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      storefront: {
        Row: {
          affiliate_link: string | null
          category: string
          color_options: string | null
          created_at: string | null
          description: string | null
          id: string
          image_url: string | null
          is_active: boolean | null
          pick_name: string
          pick_type: string | null
          product_type: string | null
          sort_order: number | null
          updated_at: string | null
          venue_id: string
        }
        Insert: {
          affiliate_link?: string | null
          category: string
          color_options?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          pick_name: string
          pick_type?: string | null
          product_type?: string | null
          sort_order?: number | null
          updated_at?: string | null
          venue_id: string
        }
        Update: {
          affiliate_link?: string | null
          category?: string
          color_options?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          pick_name?: string
          pick_type?: string | null
          product_type?: string | null
          sort_order?: number | null
          updated_at?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "storefront_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          id: string
          payload: Json | null
          processed_at: string | null
          received_at: string
          type: string
        }
        Insert: {
          id: string
          payload?: Json | null
          processed_at?: string | null
          received_at?: string
          type: string
        }
        Update: {
          id?: string
          payload?: Json | null
          processed_at?: string | null
          received_at?: string
          type?: string
        }
        Relationships: []
      }
      table_map_layouts: {
        Row: {
          created_at: string | null
          elements: Json | null
          id: string
          updated_at: string | null
          wedding_id: string
        }
        Insert: {
          created_at?: string | null
          elements?: Json | null
          id?: string
          updated_at?: string | null
          wedding_id: string
        }
        Update: {
          created_at?: string | null
          elements?: Json | null
          id?: string
          updated_at?: string | null
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "table_map_layouts_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "table_map_layouts_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      tangential_signals: {
        Row: {
          action_class: string | null
          backtrack_attempted_at: string | null
          candidate_identity_id: string | null
          confidence_score: number | null
          created_at: string
          extracted_identity: Json
          id: string
          match_status: string
          matched_person_id: string | null
          signal_class: string
          signal_date: string | null
          signal_type: string
          source_context: string | null
          source_entry_id: string | null
          source_platform: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          action_class?: string | null
          backtrack_attempted_at?: string | null
          candidate_identity_id?: string | null
          confidence_score?: number | null
          created_at?: string
          extracted_identity?: Json
          id?: string
          match_status?: string
          matched_person_id?: string | null
          signal_class: string
          signal_date?: string | null
          signal_type: string
          source_context?: string | null
          source_entry_id?: string | null
          source_platform?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          action_class?: string | null
          backtrack_attempted_at?: string | null
          candidate_identity_id?: string | null
          confidence_score?: number | null
          created_at?: string
          extracted_identity?: Json
          id?: string
          match_status?: string
          matched_person_id?: string | null
          signal_class?: string
          signal_date?: string | null
          signal_type?: string
          source_context?: string | null
          source_entry_id?: string | null
          source_platform?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tangential_signals_candidate_identity_id_fkey"
            columns: ["candidate_identity_id"]
            isOneToOne: false
            referencedRelation: "candidate_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tangential_signals_matched_person_id_fkey"
            columns: ["matched_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tangential_signals_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      tbh_reports: {
        Row: {
          agency_id: string
          conflict_findings: string | null
          created_at: string
          deleted_at: string | null
          executive_summary: string | null
          generated_at: string
          generated_by: string | null
          id: string
          llm_cost_cents: number
          llm_input_tokens: number | null
          llm_model: string | null
          llm_output_tokens: number | null
          mode: string
          notes_for_agency: string | null
          period_end: string
          period_start: string
          prompt_version: string | null
          recommendations: string | null
          short_code: string
          snapshot: Json
          venue_id: string | null
        }
        Insert: {
          agency_id: string
          conflict_findings?: string | null
          created_at?: string
          deleted_at?: string | null
          executive_summary?: string | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          llm_cost_cents?: number
          llm_input_tokens?: number | null
          llm_model?: string | null
          llm_output_tokens?: number | null
          mode?: string
          notes_for_agency?: string | null
          period_end: string
          period_start: string
          prompt_version?: string | null
          recommendations?: string | null
          short_code: string
          snapshot?: Json
          venue_id?: string | null
        }
        Update: {
          agency_id?: string
          conflict_findings?: string | null
          created_at?: string
          deleted_at?: string | null
          executive_summary?: string | null
          generated_at?: string
          generated_by?: string | null
          id?: string
          llm_cost_cents?: number
          llm_input_tokens?: number | null
          llm_model?: string | null
          llm_output_tokens?: number | null
          mode?: string
          notes_for_agency?: string | null
          period_end?: string
          period_start?: string
          prompt_version?: string | null
          recommendations?: string | null
          short_code?: string
          snapshot?: Json
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tbh_reports_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tbh_reports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tbh_reports_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      team_invitations: {
        Row: {
          accepted_at: string | null
          created_at: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          org_id: string
          role: string
          status: string | null
          token: string
          token_hash: string | null
          venue_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string | null
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          org_id: string
          role: string
          status?: string | null
          token: string
          token_hash?: string | null
          venue_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          created_at?: string | null
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          org_id?: string
          role?: string
          status?: string | null
          token?: string
          token_hash?: string | null
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "team_invitations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invitations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      tiktok_ads_connections: {
        Row: {
          access_token: string | null
          advertiser_id: string | null
          advertiser_name: string | null
          connected_at: string | null
          connected_by: string | null
          created_at: string
          currency: string | null
          id: string
          last_error_at: string | null
          last_error_message: string | null
          last_synced_at: string | null
          refresh_token: string | null
          refresh_token_expires_at: string | null
          scope: string | null
          status: string
          status_reason: string | null
          token_env_key: string | null
          token_expires_at: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          access_token?: string | null
          advertiser_id?: string | null
          advertiser_name?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          last_error_at?: string | null
          last_error_message?: string | null
          last_synced_at?: string | null
          refresh_token?: string | null
          refresh_token_expires_at?: string | null
          scope?: string | null
          status?: string
          status_reason?: string | null
          token_env_key?: string | null
          token_expires_at?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          access_token?: string | null
          advertiser_id?: string | null
          advertiser_name?: string | null
          connected_at?: string | null
          connected_by?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          last_error_at?: string | null
          last_error_message?: string | null
          last_synced_at?: string | null
          refresh_token?: string | null
          refresh_token_expires_at?: string | null
          scope?: string | null
          status?: string
          status_reason?: string | null
          token_env_key?: string | null
          token_expires_at?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tiktok_ads_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tiktok_ads_connections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      timeline: {
        Row: {
          category: string | null
          config_json: Json | null
          created_at: string | null
          description: string | null
          duration_minutes: number | null
          id: string
          location: string | null
          sort_order: number | null
          time: string | null
          title: string
          updated_at: string | null
          vendor_id: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          category?: string | null
          config_json?: Json | null
          created_at?: string | null
          description?: string | null
          duration_minutes?: number | null
          id?: string
          location?: string | null
          sort_order?: number | null
          time?: string | null
          title: string
          updated_at?: string | null
          vendor_id?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          category?: string | null
          config_json?: Json | null
          created_at?: string | null
          description?: string | null
          duration_minutes?: number | null
          id?: string
          location?: string | null
          sort_order?: number | null
          time?: string | null
          title?: string
          updated_at?: string | null
          vendor_id?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "timeline_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timeline_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "timeline_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      touchpoints: {
        Row: {
          action_type: string
          agent_id: string | null
          channel: string
          confidence_tier: string | null
          couple_id: string | null
          direction: string | null
          external_id: string
          id: string
          occurred_at: string
          raw_payload: Json | null
          signal_tier: string
          venue_id: string
          zero_phase: string | null
        }
        Insert: {
          action_type: string
          agent_id?: string | null
          channel: string
          confidence_tier?: string | null
          couple_id?: string | null
          direction?: string | null
          external_id: string
          id?: string
          occurred_at: string
          raw_payload?: Json | null
          signal_tier: string
          venue_id: string
          zero_phase?: string | null
        }
        Update: {
          action_type?: string
          agent_id?: string | null
          channel?: string
          confidence_tier?: string | null
          couple_id?: string | null
          direction?: string | null
          external_id?: string
          id?: string
          occurred_at?: string
          raw_payload?: Json | null
          signal_tier?: string
          venue_id?: string
          zero_phase?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "touchpoints_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "touchpoints_couple_id_fkey"
            columns: ["couple_id"]
            isOneToOne: false
            referencedRelation: "couples"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "touchpoints_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      tour_prep_briefs: {
        Row: {
          brief_jsonb: Json
          cost_cents: number
          generated_at: string
          id: string
          prompt_version: string | null
          sent_to_coordinator_at: string | null
          tour_id: string
          venue_id: string
          viewed_at: string | null
          wedding_id: string | null
        }
        Insert: {
          brief_jsonb: Json
          cost_cents?: number
          generated_at?: string
          id?: string
          prompt_version?: string | null
          sent_to_coordinator_at?: string | null
          tour_id: string
          venue_id: string
          viewed_at?: string | null
          wedding_id?: string | null
        }
        Update: {
          brief_jsonb?: Json
          cost_cents?: number
          generated_at?: string
          id?: string
          prompt_version?: string | null
          sent_to_coordinator_at?: string | null
          tour_id?: string
          venue_id?: string
          viewed_at?: string | null
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tour_prep_briefs_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tour_prep_briefs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tour_prep_briefs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "tour_prep_briefs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      tour_prep_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          tour_id: string
          trigger_signal: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          tour_id: string
          trigger_signal?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          tour_id?: string
          trigger_signal?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tour_prep_jobs_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tour_prep_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tour_prep_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "tour_prep_jobs_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      tour_transcript_orphans: {
        Row: {
          attached_at: string | null
          attached_to_tour_id: string | null
          audio_provider: string
          created_at: string
          first_segment_at: string
          id: string
          last_segment_at: string
          segments_count: number
          session_id: string
          status: string
          transcript: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          attached_at?: string | null
          attached_to_tour_id?: string | null
          audio_provider?: string
          created_at?: string
          first_segment_at?: string
          id?: string
          last_segment_at?: string
          segments_count?: number
          session_id: string
          status?: string
          transcript?: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          attached_at?: string | null
          attached_to_tour_id?: string | null
          audio_provider?: string
          created_at?: string
          first_segment_at?: string
          id?: string
          last_segment_at?: string
          segments_count?: number
          session_id?: string
          status?: string
          transcript?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tour_transcript_orphans_attached_to_tour_id_fkey"
            columns: ["attached_to_tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tour_transcript_orphans_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      tours: {
        Row: {
          attendees: Json
          audio_provider: string | null
          booking_date: string | null
          cancellation_note: string | null
          cancellation_reason: string | null
          competing_venues: string[] | null
          conducted_by: string | null
          couple_display_name: string | null
          created_at: string | null
          crm_source: string | null
          id: string
          notes: string | null
          outcome: string | null
          scheduled_at: string | null
          session_id: string | null
          signal_class: string
          source: string | null
          tour_brief_confidence: string | null
          tour_brief_followup_draft: string | null
          tour_brief_generated_at: string | null
          tour_brief_model: string | null
          tour_brief_stale_since: string | null
          tour_brief_text: string | null
          tour_type: string | null
          transcript: string | null
          transcript_extracted: Json | null
          transcript_received_at: string | null
          venue_id: string
          weather_at_tour: Json | null
          wedding_id: string | null
        }
        Insert: {
          attendees?: Json
          audio_provider?: string | null
          booking_date?: string | null
          cancellation_note?: string | null
          cancellation_reason?: string | null
          competing_venues?: string[] | null
          conducted_by?: string | null
          couple_display_name?: string | null
          created_at?: string | null
          crm_source?: string | null
          id?: string
          notes?: string | null
          outcome?: string | null
          scheduled_at?: string | null
          session_id?: string | null
          signal_class: string
          source?: string | null
          tour_brief_confidence?: string | null
          tour_brief_followup_draft?: string | null
          tour_brief_generated_at?: string | null
          tour_brief_model?: string | null
          tour_brief_stale_since?: string | null
          tour_brief_text?: string | null
          tour_type?: string | null
          transcript?: string | null
          transcript_extracted?: Json | null
          transcript_received_at?: string | null
          venue_id: string
          weather_at_tour?: Json | null
          wedding_id?: string | null
        }
        Update: {
          attendees?: Json
          audio_provider?: string | null
          booking_date?: string | null
          cancellation_note?: string | null
          cancellation_reason?: string | null
          competing_venues?: string[] | null
          conducted_by?: string | null
          couple_display_name?: string | null
          created_at?: string | null
          crm_source?: string | null
          id?: string
          notes?: string | null
          outcome?: string | null
          scheduled_at?: string | null
          session_id?: string | null
          signal_class?: string
          source?: string | null
          tour_brief_confidence?: string | null
          tour_brief_followup_draft?: string | null
          tour_brief_generated_at?: string | null
          tour_brief_model?: string | null
          tour_brief_stale_since?: string | null
          tour_brief_text?: string | null
          tour_type?: string | null
          transcript?: string | null
          transcript_extracted?: Json | null
          transcript_received_at?: string | null
          venue_id?: string
          weather_at_tour?: Json | null
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tours_conducted_by_fkey"
            columns: ["conducted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tours_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tours_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "tours_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      tracer_run_events: {
        Row: {
          batch_index: number | null
          detail: Json | null
          id: string
          occurred_at: string
          rows_seen: number | null
          rows_written: number | null
          run_id: string
          stage: string
          status: string
          venue_id: string
        }
        Insert: {
          batch_index?: number | null
          detail?: Json | null
          id?: string
          occurred_at?: string
          rows_seen?: number | null
          rows_written?: number | null
          run_id: string
          stage: string
          status: string
          venue_id: string
        }
        Update: {
          batch_index?: number | null
          detail?: Json | null
          id?: string
          occurred_at?: string
          rows_seen?: number | null
          rows_written?: number | null
          run_id?: string
          stage?: string
          status?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tracer_run_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      tracked_data_fields: {
        Row: {
          created_at: string
          created_by: string | null
          data_type: string
          entity_type: string
          id: string
          label: string
          llm_suggestion: string | null
          source_key: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          data_type?: string
          entity_type: string
          id?: string
          label: string
          llm_suggestion?: string | null
          source_key: string
          venue_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          data_type?: string
          entity_type?: string
          id?: string
          label?: string
          llm_suggestion?: string | null
          source_key?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tracked_data_fields_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      tracked_sources: {
        Row: {
          created_at: string
          expected_cadence_days: number
          graveyard: boolean
          id: string
          last_dismissed_at: string | null
          last_reminded_at: string | null
          source_key: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          expected_cadence_days?: number
          graveyard?: boolean
          id?: string
          last_dismissed_at?: string | null
          last_reminded_at?: string | null
          source_key: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          created_at?: string
          expected_cadence_days?: number
          graveyard?: boolean
          id?: string
          last_dismissed_at?: string | null
          last_reminded_at?: string | null
          source_key?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tracked_sources_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      transcript_segments: {
        Row: {
          audio_provider: string
          created_at: string
          end_ms: number | null
          id: string
          is_user: boolean | null
          metadata: Json
          orphan_id: string | null
          session_id: string
          speaker: string | null
          speaker_normalised: string | null
          start_ms: number | null
          text: string
          tour_id: string | null
          venue_id: string
        }
        Insert: {
          audio_provider?: string
          created_at?: string
          end_ms?: number | null
          id?: string
          is_user?: boolean | null
          metadata?: Json
          orphan_id?: string | null
          session_id: string
          speaker?: string | null
          speaker_normalised?: string | null
          start_ms?: number | null
          text: string
          tour_id?: string | null
          venue_id: string
        }
        Update: {
          audio_provider?: string
          created_at?: string
          end_ms?: number | null
          id?: string
          is_user?: boolean | null
          metadata?: Json
          orphan_id?: string | null
          session_id?: string
          speaker?: string | null
          speaker_normalised?: string | null
          start_ms?: number | null
          text?: string
          tour_id?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transcript_segments_orphan_id_fkey"
            columns: ["orphan_id"]
            isOneToOne: false
            referencedRelation: "tour_transcript_orphans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transcript_segments_tour_id_fkey"
            columns: ["tour_id"]
            isOneToOne: false
            referencedRelation: "tours"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transcript_segments_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      trend_recommendations: {
        Row: {
          applied_at: string | null
          body: string | null
          created_at: string | null
          data_source: string | null
          dismissed_at: string | null
          id: string
          priority: string | null
          recommendation_type: string
          status: string | null
          supporting_data: Json | null
          title: string
          venue_id: string
        }
        Insert: {
          applied_at?: string | null
          body?: string | null
          created_at?: string | null
          data_source?: string | null
          dismissed_at?: string | null
          id?: string
          priority?: string | null
          recommendation_type: string
          status?: string | null
          supporting_data?: Json | null
          title: string
          venue_id: string
        }
        Update: {
          applied_at?: string | null
          body?: string | null
          created_at?: string | null
          data_source?: string | null
          dismissed_at?: string | null
          id?: string
          priority?: string | null
          recommendation_type?: string
          status?: string | null
          supporting_data?: Json | null
          title?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trend_recommendations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      twilio_number_claims: {
        Row: {
          claimed_at: string
          phone_e164: string
          venue_id: string
        }
        Insert: {
          claimed_at?: string
          phone_e164: string
          venue_id: string
        }
        Update: {
          claimed_at?: string
          phone_e164?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "twilio_number_claims_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      twilio_webhook_log: {
        Row: {
          body: string | null
          created_at: string | null
          from_phone: string | null
          id: string
          interaction_id: string | null
          message_sid: string
          num_media: number | null
          processed_at: string | null
          raw_payload: Json | null
          to_phone: string | null
          venue_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string | null
          from_phone?: string | null
          id?: string
          interaction_id?: string | null
          message_sid: string
          num_media?: number | null
          processed_at?: string | null
          raw_payload?: Json | null
          to_phone?: string | null
          venue_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string | null
          from_phone?: string | null
          id?: string
          interaction_id?: string | null
          message_sid?: string
          num_media?: number | null
          processed_at?: string | null
          raw_payload?: Json | null
          to_phone?: string | null
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "twilio_webhook_log_interaction_id_fkey"
            columns: ["interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "twilio_webhook_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      user_profiles: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          first_name: string | null
          id: string
          last_name: string | null
          org_id: string | null
          role: string
          venue_id: string | null
          wedding_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          first_name?: string | null
          id: string
          last_name?: string | null
          org_id?: string | null
          role?: string
          venue_id?: string | null
          wedding_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          org_id?: string | null
          role?: string
          venue_id?: string | null
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_profiles_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_profiles_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "user_profiles_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_checklist: {
        Row: {
          completed_at: string | null
          created_at: string | null
          due_date: string | null
          id: string
          is_completed: boolean | null
          notes: string | null
          sort_order: number | null
          task: string
          updated_at: string | null
          vendor_id: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          due_date?: string | null
          id?: string
          is_completed?: boolean | null
          notes?: string | null
          sort_order?: number | null
          task: string
          updated_at?: string | null
          vendor_id: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          due_date?: string | null
          id?: string
          is_completed?: boolean | null
          notes?: string | null
          sort_order?: number | null
          task?: string
          updated_at?: string | null
          vendor_id?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_checklist_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "booked_vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_checklist_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_checklist_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "vendor_checklist_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_recommendations: {
        Row: {
          bio: string | null
          click_count: number | null
          contact_email: string | null
          contact_phone: string | null
          created_at: string | null
          description: string | null
          facebook_url: string | null
          id: string
          instagram_url: string | null
          is_preferred: boolean | null
          last_updated_by_vendor: string | null
          logo_url: string | null
          offer_expires_at: string | null
          portal_token: string | null
          portal_token_expires_at: string | null
          portal_token_issued_at: string | null
          portfolio_photos: string[] | null
          pricing_info: string | null
          sort_order: number | null
          special_offer: string | null
          vendor_name: string
          vendor_type: string | null
          venue_id: string
          website_url: string | null
        }
        Insert: {
          bio?: string | null
          click_count?: number | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string | null
          description?: string | null
          facebook_url?: string | null
          id?: string
          instagram_url?: string | null
          is_preferred?: boolean | null
          last_updated_by_vendor?: string | null
          logo_url?: string | null
          offer_expires_at?: string | null
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_issued_at?: string | null
          portfolio_photos?: string[] | null
          pricing_info?: string | null
          sort_order?: number | null
          special_offer?: string | null
          vendor_name: string
          vendor_type?: string | null
          venue_id: string
          website_url?: string | null
        }
        Update: {
          bio?: string | null
          click_count?: number | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string | null
          description?: string | null
          facebook_url?: string | null
          id?: string
          instagram_url?: string | null
          is_preferred?: boolean | null
          last_updated_by_vendor?: string | null
          logo_url?: string | null
          offer_expires_at?: string | null
          portal_token?: string | null
          portal_token_expires_at?: string | null
          portal_token_issued_at?: string | null
          portfolio_photos?: string[] | null
          pricing_info?: string | null
          sort_order?: number | null
          special_offer?: string | null
          vendor_name?: string
          vendor_type?: string | null
          venue_id?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_recommendations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_agency_engagements: {
        Row: {
          agency_id: string
          channel_sub_budgets: Json
          created_at: string
          dashboard_url: string | null
          deleted_at: string | null
          ended_at: string | null
          id: string
          managed_channels: Json
          monthly_fee_cents: number
          notes: string | null
          reporting_cadence: string | null
          scope_description: string | null
          started_at: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          agency_id: string
          channel_sub_budgets?: Json
          created_at?: string
          dashboard_url?: string | null
          deleted_at?: string | null
          ended_at?: string | null
          id?: string
          managed_channels?: Json
          monthly_fee_cents?: number
          notes?: string | null
          reporting_cadence?: string | null
          scope_description?: string | null
          started_at: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          agency_id?: string
          channel_sub_budgets?: Json
          created_at?: string
          dashboard_url?: string | null
          deleted_at?: string | null
          ended_at?: string | null
          id?: string
          managed_channels?: Json
          monthly_fee_cents?: number
          notes?: string | null
          reporting_cadence?: string | null
          scope_description?: string | null
          started_at?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_agency_engagements_agency_id_fkey"
            columns: ["agency_id"]
            isOneToOne: false
            referencedRelation: "marketing_agencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_agency_engagements_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_ai_config: {
        Row: {
          accommodation_model: string | null
          ai_custom_purpose: string | null
          ai_email: string | null
          ai_emoji: string | null
          ai_name: string | null
          ai_opener_shape: string
          ai_purposes: string[]
          ai_role: string
          ai_role_title: string | null
          alcohol_model: string | null
          assistant_personality: string | null
          brevity_level: number | null
          coordinator_level: string | null
          created_at: string | null
          email_signature: string | null
          emoji_level: string | null
          enthusiasm_level: number | null
          escalation_email: string | null
          escalation_style: string | null
          event_model: string | null
          follow_up_style: string | null
          formality_level: number | null
          guests_per_bartender: number | null
          id: string
          intro_call_link: string | null
          max_follow_ups: number | null
          min_bartenders: number | null
          phrase_style: string | null
          playfulness_level: number | null
          pricing_calculator_link: string | null
          reviewer_intro: string | null
          sales_approach: string | null
          signature_closer: string | null
          signature_expressions: Json | null
          signature_greeting: string | null
          signature_phone: string | null
          signature_tagline: string | null
          signature_text_capable: boolean
          signature_website: string | null
          staff_rate: number | null
          tour_booking_link: string | null
          tour_booking_links: Json
          updated_at: string | null
          uses_contractions: boolean | null
          uses_exclamation_points: boolean | null
          vendor_policy: string | null
          venue_id: string
          vibe: string | null
          voice_dna_last_refresh_at: string | null
          warmth_level: number | null
        }
        Insert: {
          accommodation_model?: string | null
          ai_custom_purpose?: string | null
          ai_email?: string | null
          ai_emoji?: string | null
          ai_name?: string | null
          ai_opener_shape?: string
          ai_purposes?: string[]
          ai_role?: string
          ai_role_title?: string | null
          alcohol_model?: string | null
          assistant_personality?: string | null
          brevity_level?: number | null
          coordinator_level?: string | null
          created_at?: string | null
          email_signature?: string | null
          emoji_level?: string | null
          enthusiasm_level?: number | null
          escalation_email?: string | null
          escalation_style?: string | null
          event_model?: string | null
          follow_up_style?: string | null
          formality_level?: number | null
          guests_per_bartender?: number | null
          id?: string
          intro_call_link?: string | null
          max_follow_ups?: number | null
          min_bartenders?: number | null
          phrase_style?: string | null
          playfulness_level?: number | null
          pricing_calculator_link?: string | null
          reviewer_intro?: string | null
          sales_approach?: string | null
          signature_closer?: string | null
          signature_expressions?: Json | null
          signature_greeting?: string | null
          signature_phone?: string | null
          signature_tagline?: string | null
          signature_text_capable?: boolean
          signature_website?: string | null
          staff_rate?: number | null
          tour_booking_link?: string | null
          tour_booking_links?: Json
          updated_at?: string | null
          uses_contractions?: boolean | null
          uses_exclamation_points?: boolean | null
          vendor_policy?: string | null
          venue_id: string
          vibe?: string | null
          voice_dna_last_refresh_at?: string | null
          warmth_level?: number | null
        }
        Update: {
          accommodation_model?: string | null
          ai_custom_purpose?: string | null
          ai_email?: string | null
          ai_emoji?: string | null
          ai_name?: string | null
          ai_opener_shape?: string
          ai_purposes?: string[]
          ai_role?: string
          ai_role_title?: string | null
          alcohol_model?: string | null
          assistant_personality?: string | null
          brevity_level?: number | null
          coordinator_level?: string | null
          created_at?: string | null
          email_signature?: string | null
          emoji_level?: string | null
          enthusiasm_level?: number | null
          escalation_email?: string | null
          escalation_style?: string | null
          event_model?: string | null
          follow_up_style?: string | null
          formality_level?: number | null
          guests_per_bartender?: number | null
          id?: string
          intro_call_link?: string | null
          max_follow_ups?: number | null
          min_bartenders?: number | null
          phrase_style?: string | null
          playfulness_level?: number | null
          pricing_calculator_link?: string | null
          reviewer_intro?: string | null
          sales_approach?: string | null
          signature_closer?: string | null
          signature_expressions?: Json | null
          signature_greeting?: string | null
          signature_phone?: string | null
          signature_tagline?: string | null
          signature_text_capable?: boolean
          signature_website?: string | null
          staff_rate?: number | null
          tour_booking_link?: string | null
          tour_booking_links?: Json
          updated_at?: string | null
          uses_contractions?: boolean | null
          uses_exclamation_points?: boolean | null
          vendor_policy?: string | null
          venue_id?: string
          vibe?: string | null
          voice_dna_last_refresh_at?: string | null
          warmth_level?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "venue_ai_config_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_assets: {
        Row: {
          created_at: string | null
          description: string | null
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          sort_order: number | null
          storage_path: string
          title: string
          updated_at: string | null
          venue_id: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          sort_order?: number | null
          storage_path: string
          title: string
          updated_at?: string | null
          venue_id: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          sort_order?: number | null
          storage_path?: string
          title?: string
          updated_at?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_assets_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_availability: {
        Row: {
          booked_count: number
          created_at: string | null
          date: string
          id: string
          max_events: number
          notes: string | null
          status: string
          updated_at: string | null
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          booked_count?: number
          created_at?: string | null
          date: string
          id?: string
          max_events?: number
          notes?: string | null
          status?: string
          updated_at?: string | null
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          booked_count?: number
          created_at?: string | null
          date?: string
          id?: string
          max_events?: number
          notes?: string | null
          status?: string
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "booked_dates_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booked_dates_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "booked_dates_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_config: {
        Row: {
          accent_color: string | null
          auto_attach_photos: boolean
          automation_emails: string[]
          autonomous_paused: boolean
          autonomous_paused_at: string | null
          autonomous_paused_reason: string | null
          bar_model: string | null
          base_price: number | null
          benchmark_participation: boolean
          business_name: string | null
          calendly_link: string | null
          calendly_tokens: Json | null
          capacity: number | null
          catering_model: string | null
          coordinator_email: string | null
          coordinator_name: string | null
          coordinator_phone: string | null
          cost_ceiling_warned_at: string | null
          created_at: string | null
          currency: string | null
          custom_body_font_url: string | null
          custom_heading_font_url: string | null
          daily_cost_ceiling_cents: number
          favicon_url: string | null
          feature_flags: Json | null
          font_pair: string | null
          gmail_tokens: Json | null
          id: string
          identity_match_config: Json
          logo_url: string | null
          lost_auto_mark_days: number | null
          match_eligibility_band_days: number | null
          max_events_per_day: number | null
          notify_on_sensitive_auto_context: boolean
          omi_auto_match_enabled: boolean
          omi_match_window_hours: number
          omi_webhook_token: string | null
          onboarding_completed: boolean | null
          outdoor_ideal_temp_max: number
          outdoor_ideal_temp_min: number
          owner_note_to_couples: string | null
          owner_photo_url: string | null
          pixel_ingest_key: string | null
          pixel_installed_at: string | null
          portal_tagline: string | null
          primary_color: string | null
          resend_domain_id: string | null
          secondary_color: string | null
          sending_domain: string | null
          sending_domain_checked_at: string | null
          sending_domain_status: string
          sending_from_name: string | null
          social_handles: Json
          spend_auto_sync_enabled: boolean
          timezone: string | null
          updated_at: string | null
          venue_id: string
          venue_prefix: string | null
        }
        Insert: {
          accent_color?: string | null
          auto_attach_photos?: boolean
          automation_emails?: string[]
          autonomous_paused?: boolean
          autonomous_paused_at?: string | null
          autonomous_paused_reason?: string | null
          bar_model?: string | null
          base_price?: number | null
          benchmark_participation?: boolean
          business_name?: string | null
          calendly_link?: string | null
          calendly_tokens?: Json | null
          capacity?: number | null
          catering_model?: string | null
          coordinator_email?: string | null
          coordinator_name?: string | null
          coordinator_phone?: string | null
          cost_ceiling_warned_at?: string | null
          created_at?: string | null
          currency?: string | null
          custom_body_font_url?: string | null
          custom_heading_font_url?: string | null
          daily_cost_ceiling_cents?: number
          favicon_url?: string | null
          feature_flags?: Json | null
          font_pair?: string | null
          gmail_tokens?: Json | null
          id?: string
          identity_match_config?: Json
          logo_url?: string | null
          lost_auto_mark_days?: number | null
          match_eligibility_band_days?: number | null
          max_events_per_day?: number | null
          notify_on_sensitive_auto_context?: boolean
          omi_auto_match_enabled?: boolean
          omi_match_window_hours?: number
          omi_webhook_token?: string | null
          onboarding_completed?: boolean | null
          outdoor_ideal_temp_max?: number
          outdoor_ideal_temp_min?: number
          owner_note_to_couples?: string | null
          owner_photo_url?: string | null
          pixel_ingest_key?: string | null
          pixel_installed_at?: string | null
          portal_tagline?: string | null
          primary_color?: string | null
          resend_domain_id?: string | null
          secondary_color?: string | null
          sending_domain?: string | null
          sending_domain_checked_at?: string | null
          sending_domain_status?: string
          sending_from_name?: string | null
          social_handles?: Json
          spend_auto_sync_enabled?: boolean
          timezone?: string | null
          updated_at?: string | null
          venue_id: string
          venue_prefix?: string | null
        }
        Update: {
          accent_color?: string | null
          auto_attach_photos?: boolean
          automation_emails?: string[]
          autonomous_paused?: boolean
          autonomous_paused_at?: string | null
          autonomous_paused_reason?: string | null
          bar_model?: string | null
          base_price?: number | null
          benchmark_participation?: boolean
          business_name?: string | null
          calendly_link?: string | null
          calendly_tokens?: Json | null
          capacity?: number | null
          catering_model?: string | null
          coordinator_email?: string | null
          coordinator_name?: string | null
          coordinator_phone?: string | null
          cost_ceiling_warned_at?: string | null
          created_at?: string | null
          currency?: string | null
          custom_body_font_url?: string | null
          custom_heading_font_url?: string | null
          daily_cost_ceiling_cents?: number
          favicon_url?: string | null
          feature_flags?: Json | null
          font_pair?: string | null
          gmail_tokens?: Json | null
          id?: string
          identity_match_config?: Json
          logo_url?: string | null
          lost_auto_mark_days?: number | null
          match_eligibility_band_days?: number | null
          max_events_per_day?: number | null
          notify_on_sensitive_auto_context?: boolean
          omi_auto_match_enabled?: boolean
          omi_match_window_hours?: number
          omi_webhook_token?: string | null
          onboarding_completed?: boolean | null
          outdoor_ideal_temp_max?: number
          outdoor_ideal_temp_min?: number
          owner_note_to_couples?: string | null
          owner_photo_url?: string | null
          pixel_ingest_key?: string | null
          pixel_installed_at?: string | null
          portal_tagline?: string | null
          primary_color?: string | null
          resend_domain_id?: string | null
          secondary_color?: string | null
          sending_domain?: string | null
          sending_domain_checked_at?: string | null
          sending_domain_status?: string
          sending_from_name?: string | null
          social_handles?: Json
          spend_auto_sync_enabled?: boolean
          timezone?: string | null
          updated_at?: string | null
          venue_id?: string
          venue_prefix?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venue_config_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_cultural_moment_state: {
        Row: {
          cultural_moment_id: string
          decided_at: string
          decided_by: string | null
          id: string
          note: string | null
          state: string
          venue_id: string
        }
        Insert: {
          cultural_moment_id: string
          decided_at?: string
          decided_by?: string | null
          id?: string
          note?: string | null
          state: string
          venue_id: string
        }
        Update: {
          cultural_moment_id?: string
          decided_at?: string
          decided_by?: string | null
          id?: string
          note?: string | null
          state?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_cultural_moment_state_cultural_moment_id_fkey"
            columns: ["cultural_moment_id"]
            isOneToOne: false
            referencedRelation: "cultural_moments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_cultural_moment_state_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_cultural_moment_state_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_email_filter_matches: {
        Row: {
          action: string
          filter_id: string
          from_email: string
          id: string
          matched_at: string
          matched_label: string | null
          pattern: string
          pattern_type: string
          venue_id: string
        }
        Insert: {
          action: string
          filter_id: string
          from_email: string
          id?: string
          matched_at?: string
          matched_label?: string | null
          pattern: string
          pattern_type: string
          venue_id: string
        }
        Update: {
          action?: string
          filter_id?: string
          from_email?: string
          id?: string
          matched_at?: string
          matched_label?: string | null
          pattern?: string
          pattern_type?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_email_filter_matches_filter_id_fkey"
            columns: ["filter_id"]
            isOneToOne: false
            referencedRelation: "venue_email_filters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_email_filter_matches_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_email_filters: {
        Row: {
          action: string
          created_at: string
          id: string
          note: string | null
          pattern: string
          pattern_type: string
          source: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          action?: string
          created_at?: string
          id?: string
          note?: string | null
          pattern: string
          pattern_type: string
          source?: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          note?: string | null
          pattern?: string
          pattern_type?: string
          source?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_email_filters_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_forbidden_topics: {
        Row: {
          category: string | null
          created_at: string
          deleted_at: string | null
          id: string
          keyword: string
          reason: string | null
          updated_at: string
          venue_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          keyword: string
          reason?: string | null
          updated_at?: string
          venue_id: string
        }
        Update: {
          category?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          keyword?: string
          reason?: string | null
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_forbidden_topics_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_group_members: {
        Row: {
          created_at: string | null
          group_id: string
          id: string
          venue_id: string
        }
        Insert: {
          created_at?: string | null
          group_id: string
          id?: string
          venue_id: string
        }
        Update: {
          created_at?: string | null
          group_id?: string
          id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "venue_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_group_members_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_groups: {
        Row: {
          created_at: string | null
          description: string | null
          group_kind: string
          id: string
          name: string
          org_id: string
          parent_group_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          group_kind?: string
          id?: string
          name: string
          org_id: string
          parent_group_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          group_kind?: string
          id?: string
          name?: string
          org_id?: string
          parent_group_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venue_groups_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_groups_parent_group_id_fkey"
            columns: ["parent_group_id"]
            isOneToOne: false
            referencedRelation: "venue_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_health: {
        Row: {
          availability_fill_rate: number | null
          avg_revenue_score: number | null
          booking_rate_score: number | null
          calculated_at: string | null
          created_at: string | null
          data_quality_score: number | null
          id: string
          inquiry_volume_trend: number | null
          overall_score: number | null
          pipeline_score: number | null
          response_time_score: number | null
          review_score_trend: number | null
          tour_conversion_rate: number | null
          venue_id: string
        }
        Insert: {
          availability_fill_rate?: number | null
          avg_revenue_score?: number | null
          booking_rate_score?: number | null
          calculated_at?: string | null
          created_at?: string | null
          data_quality_score?: number | null
          id?: string
          inquiry_volume_trend?: number | null
          overall_score?: number | null
          pipeline_score?: number | null
          response_time_score?: number | null
          review_score_trend?: number | null
          tour_conversion_rate?: number | null
          venue_id: string
        }
        Update: {
          availability_fill_rate?: number | null
          avg_revenue_score?: number | null
          booking_rate_score?: number | null
          calculated_at?: string | null
          created_at?: string | null
          data_quality_score?: number | null
          id?: string
          inquiry_volume_trend?: number | null
          overall_score?: number | null
          pipeline_score?: number | null
          response_time_score?: number | null
          review_score_trend?: number | null
          tour_conversion_rate?: number | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_health_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_health_history: {
        Row: {
          availability_fill_rate: number | null
          avg_revenue_score: number | null
          booking_rate: number | null
          calculated_at: string
          created_at: string
          id: string
          inquiry_volume_trend: number | null
          overall_score: number | null
          response_time_trend: number | null
          review_score_trend: number | null
          tour_conversion_rate: number | null
          venue_id: string
        }
        Insert: {
          availability_fill_rate?: number | null
          avg_revenue_score?: number | null
          booking_rate?: number | null
          calculated_at?: string
          created_at?: string
          id?: string
          inquiry_volume_trend?: number | null
          overall_score?: number | null
          response_time_trend?: number | null
          review_score_trend?: number | null
          tour_conversion_rate?: number | null
          venue_id: string
        }
        Update: {
          availability_fill_rate?: number | null
          avg_revenue_score?: number | null
          booking_rate?: number | null
          calculated_at?: string
          created_at?: string
          id?: string
          inquiry_volume_trend?: number | null
          overall_score?: number | null
          response_time_trend?: number | null
          review_score_trend?: number | null
          tour_conversion_rate?: number | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_health_history_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_intel: {
        Row: {
          cost_cents: number
          couples_in_window: number
          created_at: string
          last_refreshed_at: string
          prompt_version: string
          rollup: Json
          source_window_days: number
          updated_at: string
          venue_id: string
        }
        Insert: {
          cost_cents?: number
          couples_in_window?: number
          created_at?: string
          last_refreshed_at?: string
          prompt_version: string
          rollup: Json
          source_window_days?: number
          updated_at?: string
          venue_id: string
        }
        Update: {
          cost_cents?: number
          couples_in_window?: number
          created_at?: string
          last_refreshed_at?: string
          prompt_version?: string
          rollup?: Json
          source_window_days?: number
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_intel_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_intel_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_intel_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_operational_state: {
        Row: {
          affected_space: string | null
          created_at: string
          deleted_at: string | null
          description: string | null
          end_at: string | null
          id: string
          start_at: string
          state_type: string
          title: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          affected_space?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          end_at?: string | null
          id?: string
          start_at: string
          state_type: string
          title: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          affected_space?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          end_at?: string | null
          id?: string
          start_at?: string
          state_type?: string
          title?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_operational_state_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_resources: {
        Row: {
          created_at: string | null
          icon: string | null
          id: string
          is_active: boolean | null
          is_external: boolean | null
          sort_order: number | null
          subtitle: string | null
          title: string
          updated_at: string | null
          url: string
          venue_id: string
        }
        Insert: {
          created_at?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean | null
          is_external?: boolean | null
          sort_order?: number | null
          subtitle?: string | null
          title: string
          updated_at?: string | null
          url: string
          venue_id: string
        }
        Update: {
          created_at?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean | null
          is_external?: boolean | null
          sort_order?: number | null
          subtitle?: string | null
          title?: string
          updated_at?: string | null
          url?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_resources_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_seasonal_content: {
        Row: {
          created_at: string | null
          id: string
          imagery: string | null
          phrases: string[] | null
          season: string
          venue_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          imagery?: string | null
          phrases?: string[] | null
          season: string
          venue_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          imagery?: string | null
          phrases?: string[] | null
          season?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_seasonal_content_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_thesis: {
        Row: {
          cost_cents: number
          couples_at_generation: number
          created_at: string
          generation_count: number
          last_generated_at: string
          prompt_version: string
          thesis: Json
          updated_at: string
          venue_id: string
        }
        Insert: {
          cost_cents?: number
          couples_at_generation: number
          created_at?: string
          generation_count?: number
          last_generated_at?: string
          prompt_version: string
          thesis: Json
          updated_at?: string
          venue_id: string
        }
        Update: {
          cost_cents?: number
          couples_at_generation?: number
          created_at?: string
          generation_count?: number
          last_generated_at?: string
          prompt_version?: string
          thesis?: Json
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_thesis_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_thesis_jobs: {
        Row: {
          completed_at: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_thesis_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_usps: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean | null
          sort_order: number | null
          usp_text: string
          venue_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          sort_order?: number | null
          usp_text: string
          venue_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          sort_order?: number | null
          usp_text?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_usps_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venue_vendor_domains: {
        Row: {
          added_at: string
          added_by: string | null
          confidence: number
          domain: string
          id: string
          note: string | null
          source: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          confidence?: number
          domain: string
          id?: string
          note?: string | null
          source?: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          confidence?: number
          domain?: string
          id?: string
          note?: string | null
          source?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_vendor_domains_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address_line1: string | null
          briefing_email: string | null
          census_fips: string | null
          city: string | null
          created_at: string | null
          day_of_contact_name: string | null
          day_of_contact_phone: string | null
          dc_region_proxy: boolean | null
          dunning_extension_until: string | null
          dunning_stage: string | null
          entry_instructions: string | null
          facebook_page_id: string | null
          founding_member_expires_at: string | null
          founding_member_signup_at: string | null
          gmail_backfill_cursor: number
          gmail_backfill_emails: number
          gmail_backfill_phase: string | null
          gmail_backfill_status: string | null
          gmail_backfill_updated_at: string | null
          google_place_id: string | null
          google_trends_metro: string | null
          id: string
          identity_tracer_requested_at: string | null
          inquiry_count_this_period: number
          inquiry_period_start: string | null
          is_demo: boolean | null
          is_founding_member: boolean
          latitude: number | null
          location_derivation_source: Json | null
          location_derived_at: string | null
          longitude: number | null
          metro_msa_code: string | null
          name: string
          noaa_station_id: string | null
          org_id: string | null
          owner_email: string | null
          parking_instructions: string | null
          past_due_since: string | null
          plan_tier: string | null
          pre_opening_first_paid_wedding_at: string | null
          pre_opening_grace_until: string | null
          requires_backfill: boolean
          self_knowledge_insights_enabled: boolean
          slug: string
          state: string | null
          status: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_status: string | null
          the_knot_url: string | null
          trial_ends_at: string | null
          updated_at: string | null
          wedding_wire_url: string | null
          yelp_business_id: string | null
          zip: string | null
          zola_url: string | null
        }
        Insert: {
          address_line1?: string | null
          briefing_email?: string | null
          census_fips?: string | null
          city?: string | null
          created_at?: string | null
          day_of_contact_name?: string | null
          day_of_contact_phone?: string | null
          dc_region_proxy?: boolean | null
          dunning_extension_until?: string | null
          dunning_stage?: string | null
          entry_instructions?: string | null
          facebook_page_id?: string | null
          founding_member_expires_at?: string | null
          founding_member_signup_at?: string | null
          gmail_backfill_cursor?: number
          gmail_backfill_emails?: number
          gmail_backfill_phase?: string | null
          gmail_backfill_status?: string | null
          gmail_backfill_updated_at?: string | null
          google_place_id?: string | null
          google_trends_metro?: string | null
          id?: string
          identity_tracer_requested_at?: string | null
          inquiry_count_this_period?: number
          inquiry_period_start?: string | null
          is_demo?: boolean | null
          is_founding_member?: boolean
          latitude?: number | null
          location_derivation_source?: Json | null
          location_derived_at?: string | null
          longitude?: number | null
          metro_msa_code?: string | null
          name: string
          noaa_station_id?: string | null
          org_id?: string | null
          owner_email?: string | null
          parking_instructions?: string | null
          past_due_since?: string | null
          plan_tier?: string | null
          pre_opening_first_paid_wedding_at?: string | null
          pre_opening_grace_until?: string | null
          requires_backfill?: boolean
          self_knowledge_insights_enabled?: boolean
          slug: string
          state?: string | null
          status?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string | null
          the_knot_url?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          wedding_wire_url?: string | null
          yelp_business_id?: string | null
          zip?: string | null
          zola_url?: string | null
        }
        Update: {
          address_line1?: string | null
          briefing_email?: string | null
          census_fips?: string | null
          city?: string | null
          created_at?: string | null
          day_of_contact_name?: string | null
          day_of_contact_phone?: string | null
          dc_region_proxy?: boolean | null
          dunning_extension_until?: string | null
          dunning_stage?: string | null
          entry_instructions?: string | null
          facebook_page_id?: string | null
          founding_member_expires_at?: string | null
          founding_member_signup_at?: string | null
          gmail_backfill_cursor?: number
          gmail_backfill_emails?: number
          gmail_backfill_phase?: string | null
          gmail_backfill_status?: string | null
          gmail_backfill_updated_at?: string | null
          google_place_id?: string | null
          google_trends_metro?: string | null
          id?: string
          identity_tracer_requested_at?: string | null
          inquiry_count_this_period?: number
          inquiry_period_start?: string | null
          is_demo?: boolean | null
          is_founding_member?: boolean
          latitude?: number | null
          location_derivation_source?: Json | null
          location_derived_at?: string | null
          longitude?: number | null
          metro_msa_code?: string | null
          name?: string
          noaa_station_id?: string | null
          org_id?: string | null
          owner_email?: string | null
          parking_instructions?: string | null
          past_due_since?: string | null
          plan_tier?: string | null
          pre_opening_first_paid_wedding_at?: string | null
          pre_opening_grace_until?: string | null
          requires_backfill?: boolean
          self_knowledge_insights_enabled?: boolean
          slug?: string
          state?: string | null
          status?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_status?: string | null
          the_knot_url?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          wedding_wire_url?: string | null
          yelp_business_id?: string | null
          zip?: string | null
          zola_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venues_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organisations"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_dna_derivations: {
        Row: {
          applied: boolean
          applied_at: string | null
          applied_by: string | null
          applied_fields: Json | null
          cost_cents: number | null
          derived_approved_phrases: Json
          derived_at: string
          derived_banned_phrases: Json
          derived_tone_descriptors: Json
          derived_voice_principles: Json
          dismiss_reason: string | null
          dismissed: boolean
          dismissed_at: string | null
          dismissed_by: string | null
          id: string
          prompt_version: string | null
          source_summary: Json
          venue_id: string
        }
        Insert: {
          applied?: boolean
          applied_at?: string | null
          applied_by?: string | null
          applied_fields?: Json | null
          cost_cents?: number | null
          derived_approved_phrases?: Json
          derived_at?: string
          derived_banned_phrases?: Json
          derived_tone_descriptors?: Json
          derived_voice_principles?: Json
          dismiss_reason?: string | null
          dismissed?: boolean
          dismissed_at?: string | null
          dismissed_by?: string | null
          id?: string
          prompt_version?: string | null
          source_summary?: Json
          venue_id: string
        }
        Update: {
          applied?: boolean
          applied_at?: string | null
          applied_by?: string | null
          applied_fields?: Json | null
          cost_cents?: number | null
          derived_approved_phrases?: Json
          derived_at?: string
          derived_banned_phrases?: Json
          derived_tone_descriptors?: Json
          derived_voice_principles?: Json
          dismiss_reason?: string | null
          dismissed?: boolean
          dismissed_at?: string | null
          dismissed_by?: string | null
          id?: string
          prompt_version?: string | null
          source_summary?: Json
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_dna_derivations_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_dna_jobs: {
        Row: {
          completed_at: string | null
          derivation_id: string | null
          enqueued_at: string
          error_text: string | null
          id: string
          started_at: string | null
          status: string
          trigger_signal: string | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          derivation_id?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          derivation_id?: string | null
          enqueued_at?: string
          error_text?: string | null
          id?: string
          started_at?: string | null
          status?: string
          trigger_signal?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_dna_jobs_derivation_id_fkey"
            columns: ["derivation_id"]
            isOneToOne: false
            referencedRelation: "voice_dna_derivations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voice_dna_jobs_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_preferences: {
        Row: {
          confidence_flag: string | null
          content: string
          created_at: string | null
          id: string
          preference_type: string
          sample_count: number | null
          score: number | null
          signal_date: string
          source_reference: string | null
          source_type: string | null
          source_url: string | null
          venue_id: string
        }
        Insert: {
          confidence_flag?: string | null
          content: string
          created_at?: string | null
          id?: string
          preference_type: string
          sample_count?: number | null
          score?: number | null
          signal_date?: string
          source_reference?: string | null
          source_type?: string | null
          source_url?: string | null
          venue_id: string
        }
        Update: {
          confidence_flag?: string | null
          content?: string
          created_at?: string | null
          id?: string
          preference_type?: string
          sample_count?: number | null
          score?: number | null
          signal_date?: string
          source_reference?: string | null
          source_type?: string | null
          source_url?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_preferences_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_training_responses: {
        Row: {
          content_type: string | null
          created_at: string | null
          id: string
          response: string | null
          response_reason: string | null
          round_number: number | null
          session_id: string
          signal_date: string
        }
        Insert: {
          content_type?: string | null
          created_at?: string | null
          id?: string
          response?: string | null
          response_reason?: string | null
          round_number?: number | null
          session_id: string
          signal_date?: string
        }
        Update: {
          content_type?: string | null
          created_at?: string | null
          id?: string
          response?: string | null
          response_reason?: string | null
          round_number?: number | null
          session_id?: string
          signal_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_training_responses_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "voice_training_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_training_sessions: {
        Row: {
          completed_at: string | null
          completed_rounds: number | null
          game_type: string
          id: string
          staff_email: string | null
          started_at: string | null
          total_rounds: number | null
          venue_id: string
        }
        Insert: {
          completed_at?: string | null
          completed_rounds?: number | null
          game_type: string
          id?: string
          staff_email?: string | null
          started_at?: string | null
          total_rounds?: number | null
          venue_id: string
        }
        Update: {
          completed_at?: string | null
          completed_rounds?: number | null
          game_type?: string
          id?: string
          staff_email?: string | null
          started_at?: string | null
          total_rounds?: number | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voice_training_sessions_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      weather_alerts: {
        Row: {
          area_desc: string | null
          certainty: string | null
          created_at: string
          description: string | null
          ends: string | null
          event: string | null
          expires: string | null
          fetched_at: string
          headline: string | null
          id: string
          instruction: string | null
          is_active: boolean
          message_type: string | null
          nws_id: string
          onset: string | null
          severity: string | null
          status: string | null
          urgency: string | null
          venue_id: string
        }
        Insert: {
          area_desc?: string | null
          certainty?: string | null
          created_at?: string
          description?: string | null
          ends?: string | null
          event?: string | null
          expires?: string | null
          fetched_at?: string
          headline?: string | null
          id?: string
          instruction?: string | null
          is_active?: boolean
          message_type?: string | null
          nws_id: string
          onset?: string | null
          severity?: string | null
          status?: string | null
          urgency?: string | null
          venue_id: string
        }
        Update: {
          area_desc?: string | null
          certainty?: string | null
          created_at?: string
          description?: string | null
          ends?: string | null
          event?: string | null
          expires?: string | null
          fetched_at?: string
          headline?: string | null
          id?: string
          instruction?: string | null
          is_active?: boolean
          message_type?: string | null
          nws_id?: string
          onset?: string | null
          severity?: string | null
          status?: string | null
          urgency?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weather_alerts_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      weather_anomaly_events: {
        Row: {
          description: string
          duration_days: number
          end_date: string
          event_type: string
          id: string
          inquiries_during: number | null
          inquiries_typical: number | null
          max_temp_f: number | null
          min_temp_f: number | null
          refreshed_at: string
          severity: string
          start_date: string
          total_precip_in: number | null
          total_snow_in: number | null
          tours_during: number | null
          tours_typical: number | null
          venue_id: string
        }
        Insert: {
          description: string
          duration_days: number
          end_date: string
          event_type: string
          id?: string
          inquiries_during?: number | null
          inquiries_typical?: number | null
          max_temp_f?: number | null
          min_temp_f?: number | null
          refreshed_at?: string
          severity: string
          start_date: string
          total_precip_in?: number | null
          total_snow_in?: number | null
          tours_during?: number | null
          tours_typical?: number | null
          venue_id: string
        }
        Update: {
          description?: string
          duration_days?: number
          end_date?: string
          event_type?: string
          id?: string
          inquiries_during?: number | null
          inquiries_typical?: number | null
          max_temp_f?: number | null
          min_temp_f?: number | null
          refreshed_at?: string
          severity?: string
          start_date?: string
          total_precip_in?: number | null
          total_snow_in?: number | null
          tours_during?: number | null
          tours_typical?: number | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weather_anomaly_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      weather_climate_annual: {
        Row: {
          mean_high_f: number | null
          month_num: number
          refreshed_at: string
          sample_days: number
          total_precip_in: number | null
          venue_id: string
          year: number
        }
        Insert: {
          mean_high_f?: number | null
          month_num: number
          refreshed_at?: string
          sample_days?: number
          total_precip_in?: number | null
          venue_id: string
          year: number
        }
        Update: {
          mean_high_f?: number | null
          month_num?: number
          refreshed_at?: string
          sample_days?: number
          total_precip_in?: number | null
          venue_id?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "weather_climate_annual_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      weather_climate_norms: {
        Row: {
          hour_local: number
          month_num: number
          prior_precip_avg_in: number | null
          prior_precip_prob_pct: number | null
          prior_sample_count: number
          prior_temp_avg_f: number | null
          prior_window_end: string | null
          prior_window_start: string | null
          recent_precip_avg_in: number | null
          recent_precip_prob_pct: number | null
          recent_sample_count: number
          recent_temp_avg_f: number | null
          recent_temp_p10_f: number | null
          recent_temp_p90_f: number | null
          recent_window_end: string | null
          recent_window_start: string | null
          refreshed_at: string
          venue_id: string
        }
        Insert: {
          hour_local: number
          month_num: number
          prior_precip_avg_in?: number | null
          prior_precip_prob_pct?: number | null
          prior_sample_count?: number
          prior_temp_avg_f?: number | null
          prior_window_end?: string | null
          prior_window_start?: string | null
          recent_precip_avg_in?: number | null
          recent_precip_prob_pct?: number | null
          recent_sample_count?: number
          recent_temp_avg_f?: number | null
          recent_temp_p10_f?: number | null
          recent_temp_p90_f?: number | null
          recent_window_end?: string | null
          recent_window_start?: string | null
          refreshed_at?: string
          venue_id: string
        }
        Update: {
          hour_local?: number
          month_num?: number
          prior_precip_avg_in?: number | null
          prior_precip_prob_pct?: number | null
          prior_sample_count?: number
          prior_temp_avg_f?: number | null
          prior_window_end?: string | null
          prior_window_start?: string | null
          recent_precip_avg_in?: number | null
          recent_precip_prob_pct?: number | null
          recent_sample_count?: number
          recent_temp_avg_f?: number | null
          recent_temp_p10_f?: number | null
          recent_temp_p90_f?: number | null
          recent_window_end?: string | null
          recent_window_start?: string | null
          refreshed_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "weather_climate_norms_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      weather_data: {
        Row: {
          avg_humidity_pct: number | null
          avg_temp_4pm_f: number | null
          avg_wind_mph: number | null
          conditions: string | null
          date: string
          high_temp: number | null
          id: string
          low_temp: number | null
          month: number | null
          outdoor_event_score: number | null
          precipitation: number | null
          source: string | null
          sunny_days: number | null
          venue_id: string
          year: number | null
        }
        Insert: {
          avg_humidity_pct?: number | null
          avg_temp_4pm_f?: number | null
          avg_wind_mph?: number | null
          conditions?: string | null
          date: string
          high_temp?: number | null
          id?: string
          low_temp?: number | null
          month?: number | null
          outdoor_event_score?: number | null
          precipitation?: number | null
          source?: string | null
          sunny_days?: number | null
          venue_id: string
          year?: number | null
        }
        Update: {
          avg_humidity_pct?: number | null
          avg_temp_4pm_f?: number | null
          avg_wind_mph?: number | null
          conditions?: string | null
          date?: string
          high_temp?: number | null
          id?: string
          low_temp?: number | null
          month?: number | null
          outdoor_event_score?: number | null
          precipitation?: number | null
          source?: string | null
          sunny_days?: number | null
          venue_id?: string
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "weather_data_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      web_visits: {
        Row: {
          anon_visitor_id: string
          candidate_identity_id: string | null
          created_at: string
          fbclid: string | null
          gclid: string | null
          id: string
          ip_hash: string | null
          landing_path: string | null
          msclkid: string | null
          occurred_at: string
          referrer: string | null
          resolved_at: string | null
          ttclid: string | null
          user_agent_hash: string | null
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          venue_id: string
        }
        Insert: {
          anon_visitor_id: string
          candidate_identity_id?: string | null
          created_at?: string
          fbclid?: string | null
          gclid?: string | null
          id?: string
          ip_hash?: string | null
          landing_path?: string | null
          msclkid?: string | null
          occurred_at?: string
          referrer?: string | null
          resolved_at?: string | null
          ttclid?: string | null
          user_agent_hash?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          venue_id: string
        }
        Update: {
          anon_visitor_id?: string
          candidate_identity_id?: string | null
          created_at?: string
          fbclid?: string | null
          gclid?: string | null
          id?: string
          ip_hash?: string | null
          landing_path?: string | null
          msclkid?: string | null
          occurred_at?: string
          referrer?: string | null
          resolved_at?: string | null
          ttclid?: string | null
          user_agent_hash?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "web_visits_candidate_identity_id_fkey"
            columns: ["candidate_identity_id"]
            isOneToOne: false
            referencedRelation: "candidate_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "web_visits_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      website_contacts: {
        Row: {
          created_at: string | null
          email: string
          id: string
          message: string | null
          name: string
          read: boolean | null
          venue_count: string | null
          venue_name: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
          message?: string | null
          name: string
          read?: boolean | null
          venue_count?: string | null
          venue_name?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
          message?: string | null
          name?: string
          read?: boolean | null
          venue_count?: string | null
          venue_name?: string | null
        }
        Relationships: []
      }
      website_content: {
        Row: {
          content_type: string
          created_at: string | null
          id: string
          key: string
          page: string
          section: string
          updated_at: string | null
          value: string
        }
        Insert: {
          content_type?: string
          created_at?: string | null
          id?: string
          key: string
          page: string
          section?: string
          updated_at?: string | null
          value?: string
        }
        Update: {
          content_type?: string
          created_at?: string | null
          id?: string
          key?: string
          page?: string
          section?: string
          updated_at?: string | null
          value?: string
        }
        Relationships: []
      }
      website_faqs: {
        Row: {
          active: boolean | null
          answer: string
          category: string
          created_at: string | null
          id: string
          question: string
          sort_order: number
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          answer: string
          category?: string
          created_at?: string | null
          id?: string
          question: string
          sort_order?: number
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          answer?: string
          category?: string
          created_at?: string | null
          id?: string
          question?: string
          sort_order?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      website_images: {
        Row: {
          alt_text: string
          created_at: string | null
          id: string
          key: string
          page: string
          section: string
          sort_order: number
          updated_at: string | null
          url: string
        }
        Insert: {
          alt_text?: string
          created_at?: string | null
          id?: string
          key: string
          page: string
          section?: string
          sort_order?: number
          updated_at?: string | null
          url: string
        }
        Update: {
          alt_text?: string
          created_at?: string | null
          id?: string
          key?: string
          page?: string
          section?: string
          sort_order?: number
          updated_at?: string | null
          url?: string
        }
        Relationships: []
      }
      website_pricing: {
        Row: {
          active: boolean | null
          created_at: string | null
          description: string
          features: Json
          highlighted: boolean | null
          id: string
          name: string
          price_display: string
          sort_order: number
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          created_at?: string | null
          description?: string
          features?: Json
          highlighted?: boolean | null
          id?: string
          name: string
          price_display?: string
          sort_order?: number
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          created_at?: string | null
          description?: string
          features?: Json
          highlighted?: boolean | null
          id?: string
          name?: string
          price_display?: string
          sort_order?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      website_team: {
        Row: {
          active: boolean | null
          bio: string
          created_at: string | null
          id: string
          name: string
          photo_url: string | null
          sort_order: number
          title: string
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          bio?: string
          created_at?: string | null
          id?: string
          name: string
          photo_url?: string | null
          sort_order?: number
          title?: string
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          bio?: string
          created_at?: string | null
          id?: string
          name?: string
          photo_url?: string | null
          sort_order?: number
          title?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      website_testimonials: {
        Row: {
          active: boolean | null
          created_at: string | null
          featured: boolean | null
          id: string
          name: string
          photo_url: string | null
          quote: string
          role: string
          sort_order: number
          updated_at: string | null
          venue_name: string | null
        }
        Insert: {
          active?: boolean | null
          created_at?: string | null
          featured?: boolean | null
          id?: string
          name: string
          photo_url?: string | null
          quote: string
          role?: string
          sort_order?: number
          updated_at?: string | null
          venue_name?: string | null
        }
        Update: {
          active?: boolean | null
          created_at?: string | null
          featured?: boolean | null
          id?: string
          name?: string
          photo_url?: string | null
          quote?: string
          role?: string
          sort_order?: number
          updated_at?: string | null
          venue_name?: string | null
        }
        Relationships: []
      }
      website_traffic_history: {
        Row: {
          channel_group: string
          created_at: string
          engaged_sessions: number
          engagement_rate: number | null
          id: string
          key_events: number
          period_end: string
          period_start: string
          session_key_event_rate: number | null
          sessions: number
          source: string
          venue_id: string
        }
        Insert: {
          channel_group: string
          created_at?: string
          engaged_sessions?: number
          engagement_rate?: number | null
          id?: string
          key_events?: number
          period_end: string
          period_start: string
          session_key_event_rate?: number | null
          sessions?: number
          source?: string
          venue_id: string
        }
        Update: {
          channel_group?: string
          created_at?: string
          engaged_sessions?: number
          engagement_rate?: number | null
          id?: string
          key_events?: number
          period_end?: string
          period_start?: string
          session_key_event_rate?: number | null
          sessions?: number
          source?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "website_traffic_history_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_auto_context: {
        Row: {
          added_by: string | null
          archived_at: string | null
          archived_by: string | null
          body: string
          category: string | null
          confidence: number | null
          created_at: string
          expires_at: string | null
          id: string
          is_active: boolean
          pinned: boolean
          sensitive: boolean
          source: string
          source_interaction_id: string | null
          updated_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          added_by?: string | null
          archived_at?: string | null
          archived_by?: string | null
          body: string
          category?: string | null
          confidence?: number | null
          created_at?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          pinned?: boolean
          sensitive?: boolean
          source: string
          source_interaction_id?: string | null
          updated_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          added_by?: string | null
          archived_at?: string | null
          archived_by?: string | null
          body?: string
          category?: string | null
          confidence?: number | null
          created_at?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          pinned?: boolean
          sensitive?: boolean
          source?: string
          source_interaction_id?: string | null
          updated_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_auto_context_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_auto_context_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_auto_context_source_interaction_id_fkey"
            columns: ["source_interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_auto_context_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_auto_context_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_auto_context_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_config: {
        Row: {
          budget_shared: boolean | null
          created_at: string | null
          custom_categories: Json | null
          id: string
          plated_meal: boolean | null
          total_budget: number | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          budget_shared?: boolean | null
          created_at?: string | null
          custom_categories?: Json | null
          id?: string
          plated_meal?: boolean | null
          total_budget?: number | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          budget_shared?: boolean | null
          created_at?: string | null
          custom_categories?: Json | null
          id?: string
          plated_meal?: boolean | null
          total_budget?: number | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_config_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_config_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_config_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_detail_config: {
        Row: {
          allow_bubbles: boolean | null
          allow_champagne_glasses: boolean | null
          allow_charger_plates: boolean | null
          allow_inside_ceremony: boolean | null
          allow_outside_ceremony: boolean | null
          allow_sparklers: boolean | null
          allow_unity_table: boolean | null
          allow_wands: boolean | null
          arbor_options: string[] | null
          created_at: string | null
          custom_fields: Json | null
          custom_send_off_options: string[] | null
          id: string
          updated_at: string | null
          venue_id: string
        }
        Insert: {
          allow_bubbles?: boolean | null
          allow_champagne_glasses?: boolean | null
          allow_charger_plates?: boolean | null
          allow_inside_ceremony?: boolean | null
          allow_outside_ceremony?: boolean | null
          allow_sparklers?: boolean | null
          allow_unity_table?: boolean | null
          allow_wands?: boolean | null
          arbor_options?: string[] | null
          created_at?: string | null
          custom_fields?: Json | null
          custom_send_off_options?: string[] | null
          id?: string
          updated_at?: string | null
          venue_id: string
        }
        Update: {
          allow_bubbles?: boolean | null
          allow_champagne_glasses?: boolean | null
          allow_charger_plates?: boolean | null
          allow_inside_ceremony?: boolean | null
          allow_outside_ceremony?: boolean | null
          allow_sparklers?: boolean | null
          allow_unity_table?: boolean | null
          allow_wands?: boolean | null
          arbor_options?: string[] | null
          created_at?: string | null
          custom_fields?: Json | null
          custom_send_off_options?: string[] | null
          id?: string
          updated_at?: string | null
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_detail_config_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_details: {
        Row: {
          arbor_choice: string | null
          ceremony_location: string | null
          ceremony_notes: string | null
          contract_checkin: string | null
          contract_checkout: string | null
          contract_max_rehearsal: number | null
          contract_max_wedding: number | null
          contract_overnights: number | null
          contract_rehearsal_hours: string | null
          contract_wedding_hours: string | null
          created_at: string | null
          custom_field_values: Json | null
          dog_sitter_name: string | null
          dog_sitter_time: string | null
          dogs_coming: boolean | null
          dogs_description: string | null
          extra_fields: Json | null
          favors_description: string | null
          high_chairs: string | null
          id: string
          partner1_parents: string | null
          partner1_parents_met: boolean | null
          partner1_social: string | null
          partner2_parents: string | null
          partner2_parents_met: boolean | null
          partner2_social: string | null
          providing_cake_cutter: boolean | null
          providing_cake_topper: boolean | null
          providing_champagne_glasses: boolean | null
          providing_charger_plates: boolean | null
          providing_table_numbers: boolean | null
          reception_notes: string | null
          seating_method: string | null
          send_off_notes: string | null
          send_off_type: string | null
          unity_table: boolean | null
          updated_at: string | null
          venue_id: string
          wedding_colors: string | null
          wedding_id: string
          wedding_party_count: string | null
        }
        Insert: {
          arbor_choice?: string | null
          ceremony_location?: string | null
          ceremony_notes?: string | null
          contract_checkin?: string | null
          contract_checkout?: string | null
          contract_max_rehearsal?: number | null
          contract_max_wedding?: number | null
          contract_overnights?: number | null
          contract_rehearsal_hours?: string | null
          contract_wedding_hours?: string | null
          created_at?: string | null
          custom_field_values?: Json | null
          dog_sitter_name?: string | null
          dog_sitter_time?: string | null
          dogs_coming?: boolean | null
          dogs_description?: string | null
          extra_fields?: Json | null
          favors_description?: string | null
          high_chairs?: string | null
          id?: string
          partner1_parents?: string | null
          partner1_parents_met?: boolean | null
          partner1_social?: string | null
          partner2_parents?: string | null
          partner2_parents_met?: boolean | null
          partner2_social?: string | null
          providing_cake_cutter?: boolean | null
          providing_cake_topper?: boolean | null
          providing_champagne_glasses?: boolean | null
          providing_charger_plates?: boolean | null
          providing_table_numbers?: boolean | null
          reception_notes?: string | null
          seating_method?: string | null
          send_off_notes?: string | null
          send_off_type?: string | null
          unity_table?: boolean | null
          updated_at?: string | null
          venue_id: string
          wedding_colors?: string | null
          wedding_id: string
          wedding_party_count?: string | null
        }
        Update: {
          arbor_choice?: string | null
          ceremony_location?: string | null
          ceremony_notes?: string | null
          contract_checkin?: string | null
          contract_checkout?: string | null
          contract_max_rehearsal?: number | null
          contract_max_wedding?: number | null
          contract_overnights?: number | null
          contract_rehearsal_hours?: string | null
          contract_wedding_hours?: string | null
          created_at?: string | null
          custom_field_values?: Json | null
          dog_sitter_name?: string | null
          dog_sitter_time?: string | null
          dogs_coming?: boolean | null
          dogs_description?: string | null
          extra_fields?: Json | null
          favors_description?: string | null
          high_chairs?: string | null
          id?: string
          partner1_parents?: string | null
          partner1_parents_met?: boolean | null
          partner1_social?: string | null
          partner2_parents?: string | null
          partner2_parents_met?: boolean | null
          partner2_social?: string | null
          providing_cake_cutter?: boolean | null
          providing_cake_topper?: boolean | null
          providing_champagne_glasses?: boolean | null
          providing_charger_plates?: boolean | null
          providing_table_numbers?: boolean | null
          reception_notes?: string | null
          seating_method?: string | null
          send_off_notes?: string | null
          send_off_type?: string | null
          unity_table?: boolean | null
          updated_at?: string | null
          venue_id?: string
          wedding_colors?: string | null
          wedding_id?: string
          wedding_party_count?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wedding_details_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_details_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_details_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_internal_notes: {
        Row: {
          content: string
          created_at: string | null
          created_by: string | null
          id: string
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          content: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          content?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_internal_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_internal_notes_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_internal_notes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_internal_notes_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_journey_narratives: {
        Row: {
          attribution_count_at_generation: number
          created_at: string
          generated_at: string
          generated_by: string | null
          generating_at: string | null
          id: string
          model: string | null
          narrative_text: string
          pinned: boolean
          signal_count_at_generation: number
          stale_since: string | null
          updated_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          attribution_count_at_generation?: number
          created_at?: string
          generated_at?: string
          generated_by?: string | null
          generating_at?: string | null
          id?: string
          model?: string | null
          narrative_text: string
          pinned?: boolean
          signal_count_at_generation?: number
          stale_since?: string | null
          updated_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          attribution_count_at_generation?: number
          created_at?: string
          generated_at?: string
          generated_by?: string | null
          generating_at?: string | null
          id?: string
          model?: string | null
          narrative_text?: string
          pinned?: boolean
          signal_count_at_generation?: number
          stale_since?: string | null
          updated_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_journey_narratives_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_journey_narratives_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_journey_narratives_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: true
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_lifecycle_events: {
        Row: {
          confidence: number | null
          created_at: string
          detected_by: string
          id: string
          reason: string | null
          signal: string
          source_interaction_id: string | null
          status_from: string | null
          status_to: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          detected_by: string
          id?: string
          reason?: string | null
          signal: string
          source_interaction_id?: string | null
          status_from?: string | null
          status_to?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          detected_by?: string
          id?: string
          reason?: string | null
          signal?: string
          source_interaction_id?: string | null
          status_from?: string | null
          status_to?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_lifecycle_events_source_interaction_id_fkey"
            columns: ["source_interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_lifecycle_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_lifecycle_events_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_lifecycle_events_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_party: {
        Row: {
          bio: string | null
          blurb: string | null
          created_at: string | null
          id: string
          name: string
          photo_url: string | null
          relationship: string | null
          role: string | null
          side: string | null
          sort_order: number | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          bio?: string | null
          blurb?: string | null
          created_at?: string | null
          id?: string
          name: string
          photo_url?: string | null
          relationship?: string | null
          role?: string | null
          side?: string | null
          sort_order?: number | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          bio?: string | null
          blurb?: string | null
          created_at?: string | null
          id?: string
          name?: string
          photo_url?: string | null
          relationship?: string | null
          role?: string | null
          side?: string | null
          sort_order?: number | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_party_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_party_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_party_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_priorities: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          section_slug: string
          sort_order: number
          updated_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          section_slug: string
          sort_order?: number
          updated_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          section_slug?: string
          sort_order?: number
          updated_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_priorities_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_priorities_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_priorities_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_priorities_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_relationships: {
        Row: {
          added_by: string | null
          archived_at: string | null
          archived_by: string | null
          confidence: number | null
          created_at: string
          detail: string | null
          email: string | null
          full_name: string
          id: string
          is_active: boolean
          phone: string | null
          relationship_role: string
          source: string
          source_interaction_id: string | null
          updated_at: string
          venue_id: string
          wedding_id: string
        }
        Insert: {
          added_by?: string | null
          archived_at?: string | null
          archived_by?: string | null
          confidence?: number | null
          created_at?: string
          detail?: string | null
          email?: string | null
          full_name: string
          id?: string
          is_active?: boolean
          phone?: string | null
          relationship_role: string
          source: string
          source_interaction_id?: string | null
          updated_at?: string
          venue_id: string
          wedding_id: string
        }
        Update: {
          added_by?: string | null
          archived_at?: string | null
          archived_by?: string | null
          confidence?: number | null
          created_at?: string
          detail?: string | null
          email?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          phone?: string | null
          relationship_role?: string
          source?: string
          source_interaction_id?: string | null
          updated_at?: string
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_relationships_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_relationships_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_relationships_source_interaction_id_fkey"
            columns: ["source_interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_relationships_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_relationships_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_relationships_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_tables: {
        Row: {
          centerpiece_notes: string | null
          chargers: boolean | null
          checkered_dance_floor: boolean | null
          cocktail_tables: number | null
          created_at: string | null
          extra_fields: Json | null
          extra_tables: Json | null
          guest_count: number | null
          guests_per_table: number | null
          head_table: boolean | null
          head_table_people: number | null
          head_table_sided: string | null
          id: string
          is_draft: boolean | null
          kids_count: number | null
          kids_table: boolean | null
          layout_notes: string | null
          linen_color: string | null
          linen_notes: string | null
          linen_venue_choice: boolean | null
          lounge_area: boolean | null
          napkin_color: string | null
          rect_table_count: number | null
          runner_style: string | null
          sweetheart_table: boolean | null
          table_shape: string | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          centerpiece_notes?: string | null
          chargers?: boolean | null
          checkered_dance_floor?: boolean | null
          cocktail_tables?: number | null
          created_at?: string | null
          extra_fields?: Json | null
          extra_tables?: Json | null
          guest_count?: number | null
          guests_per_table?: number | null
          head_table?: boolean | null
          head_table_people?: number | null
          head_table_sided?: string | null
          id?: string
          is_draft?: boolean | null
          kids_count?: number | null
          kids_table?: boolean | null
          layout_notes?: string | null
          linen_color?: string | null
          linen_notes?: string | null
          linen_venue_choice?: boolean | null
          lounge_area?: boolean | null
          napkin_color?: string | null
          rect_table_count?: number | null
          runner_style?: string | null
          sweetheart_table?: boolean | null
          table_shape?: string | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          centerpiece_notes?: string | null
          chargers?: boolean | null
          checkered_dance_floor?: boolean | null
          cocktail_tables?: number | null
          created_at?: string | null
          extra_fields?: Json | null
          extra_tables?: Json | null
          guest_count?: number | null
          guests_per_table?: number | null
          head_table?: boolean | null
          head_table_people?: number | null
          head_table_sided?: string | null
          id?: string
          is_draft?: boolean | null
          kids_count?: number | null
          kids_table?: boolean | null
          layout_notes?: string | null
          linen_color?: string | null
          linen_notes?: string | null
          linen_venue_choice?: boolean | null
          lounge_area?: boolean | null
          napkin_color?: string | null
          rect_table_count?: number | null
          runner_style?: string | null
          sweetheart_table?: boolean | null
          table_shape?: string | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_tables_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_tables_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_tables_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_touchpoints: {
        Row: {
          campaign: string | null
          created_at: string
          id: string
          medium: string | null
          metadata: Json
          occurred_at: string
          signal_class: string
          signal_id: string | null
          source: string | null
          touch_type: string
          venue_id: string
          wedding_id: string | null
        }
        Insert: {
          campaign?: string | null
          created_at?: string
          id?: string
          medium?: string | null
          metadata?: Json
          occurred_at?: string
          signal_class?: string
          signal_id?: string | null
          source?: string | null
          touch_type?: string
          venue_id: string
          wedding_id?: string | null
        }
        Update: {
          campaign?: string | null
          created_at?: string
          id?: string
          medium?: string | null
          metadata?: Json
          occurred_at?: string
          signal_class?: string
          signal_id?: string | null
          source?: string | null
          touch_type?: string
          venue_id?: string
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wedding_touchpoints_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_touchpoints_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_touchpoints_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_website_settings: {
        Row: {
          accent_color: string | null
          couple_names: string | null
          created_at: string | null
          dress_code: string | null
          faq: Json | null
          id: string
          is_published: boolean | null
          our_story: string | null
          partner1_name: string | null
          partner2_name: string | null
          registry_links: Json | null
          sections: Json | null
          sections_enabled: Json | null
          sections_order: string[] | null
          share_token: string
          share_token_issued_at: string | null
          site_password: string | null
          slug: string | null
          theme: string | null
          things_to_do: Json | null
          updated_at: string | null
          venue_address: string | null
          venue_id: string
          venue_name: string | null
          wedding_date: string | null
          wedding_id: string
        }
        Insert: {
          accent_color?: string | null
          couple_names?: string | null
          created_at?: string | null
          dress_code?: string | null
          faq?: Json | null
          id?: string
          is_published?: boolean | null
          our_story?: string | null
          partner1_name?: string | null
          partner2_name?: string | null
          registry_links?: Json | null
          sections?: Json | null
          sections_enabled?: Json | null
          sections_order?: string[] | null
          share_token?: string
          share_token_issued_at?: string | null
          site_password?: string | null
          slug?: string | null
          theme?: string | null
          things_to_do?: Json | null
          updated_at?: string | null
          venue_address?: string | null
          venue_id: string
          venue_name?: string | null
          wedding_date?: string | null
          wedding_id: string
        }
        Update: {
          accent_color?: string | null
          couple_names?: string | null
          created_at?: string | null
          dress_code?: string | null
          faq?: Json | null
          id?: string
          is_published?: boolean | null
          our_story?: string | null
          partner1_name?: string | null
          partner2_name?: string | null
          registry_links?: Json | null
          sections?: Json | null
          sections_enabled?: Json | null
          sections_order?: string[] | null
          share_token?: string
          share_token_issued_at?: string | null
          site_password?: string | null
          slug?: string | null
          theme?: string | null
          things_to_do?: Json | null
          updated_at?: string | null
          venue_address?: string | null
          venue_id?: string
          venue_name?: string | null
          wedding_date?: string | null
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_website_settings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_website_settings_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_website_settings_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_worksheets: {
        Row: {
          content: Json | null
          created_at: string | null
          id: string
          section: string | null
          updated_at: string | null
          venue_id: string
          wedding_id: string
        }
        Insert: {
          content?: Json | null
          created_at?: string | null
          id?: string
          section?: string | null
          updated_at?: string | null
          venue_id: string
          wedding_id: string
        }
        Update: {
          content?: Json | null
          created_at?: string | null
          id?: string
          section?: string | null
          updated_at?: string | null
          venue_id?: string
          wedding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wedding_worksheets_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_worksheets_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_worksheets_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      weddings: {
        Row: {
          ai_opted_out: boolean
          ai_opted_out_at: string | null
          ai_opted_out_reason: string | null
          amount_paid: number | null
          assigned_consultant_id: string | null
          attribution_priority: Json | null
          auto_send_block_reason: string | null
          auto_send_blocked_at: string | null
          booked_at: string | null
          booking_value: number | null
          calendly_qa: Json | null
          cancelled_at: string | null
          ceremony_start: string | null
          ceremony_start_confirmed_at: string | null
          ceremony_start_confirmed_by: string | null
          code_extension: string | null
          confidence_flag: string | null
          contracted_at: string | null
          couple_invited_at: string | null
          couple_photo_url: string | null
          couple_registered_at: string | null
          created_at: string | null
          crm_external_id: string | null
          crm_source: string | null
          crm_team_members: Json | null
          day_of_timeline_locked: boolean
          day_of_timeline_locked_at: string | null
          day_of_timeline_locked_by: string | null
          deposit_amount: number | null
          dietary_summary: string | null
          estimated_guests: number | null
          event_code: string | null
          family_context: string | null
          field_source: Json
          first_response_at: string | null
          first_touch_overridden_at: string | null
          first_touch_overridden_by: string | null
          friction_tags: Json
          gratuity_amount: number | null
          guest_count_estimate: number | null
          guest_count_evidence: Json
          guest_count_locked_at: string | null
          guest_count_locked_by: string | null
          guest_count_locked_by_operator: boolean
          has_toured_in_person: boolean
          has_toured_in_person_at: string | null
          heat_recompute_pending: boolean
          heat_score_overridden_at: string | null
          heat_score_overridden_by: string | null
          heat_score_override_value: number | null
          hold_expires_at: string | null
          id: string
          import_warnings: Json | null
          inquiry_date: string | null
          inquiry_date_evidence: Json
          inquiry_date_locked_at: string | null
          inquiry_date_locked_by: string | null
          inquiry_date_locked_by_operator: boolean
          lead_source: string | null
          lead_source_derivation_attempted_at: string | null
          lifecycle_stage: string | null
          lifecycle_stage_set_at: string | null
          lifecycle_transition_count: number
          lost_at: string | null
          lost_locked_at: string | null
          lost_locked_by: string | null
          lost_locked_by_operator: boolean
          lost_reason: string | null
          merged_into_id: string | null
          narrative_cache_busted_at: string | null
          non_couple_at: string | null
          non_couple_reason: string | null
          notes: string | null
          package: string | null
          package_name: string | null
          partner_count: number | null
          persona_label: string | null
          persona_label_overridden_at: string | null
          persona_label_overridden_by: string | null
          previous_wedding_id: string | null
          quoted_value: number | null
          raw_import_row: Json | null
          reception_end: string | null
          reception_end_confirmed_at: string | null
          reception_end_confirmed_by: string | null
          referred_by: string | null
          refunded_amount: number | null
          requested_date: string | null
          sage_context_notes: Json
          sms_scheduling_extracted_at: string | null
          source: string | null
          source_detail: string | null
          source_evidence: Json
          source_kind: string | null
          source_locked_at: string | null
          source_locked_by: string | null
          source_locked_by_operator: boolean
          source_provenance: string | null
          source_records: Json
          status: string | null
          tax_amount: number | null
          tour_date: string | null
          updated_at: string | null
          utm_campaign: string | null
          utm_content: string | null
          utm_first_seen_at: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
          venue_id: string
          wedding_date: string | null
          wedding_date_evidence: Json
          wedding_date_locked_at: string | null
          wedding_date_locked_by: string | null
          wedding_date_locked_by_operator: boolean
          wedding_date_precision: string | null
        }
        Insert: {
          ai_opted_out?: boolean
          ai_opted_out_at?: string | null
          ai_opted_out_reason?: string | null
          amount_paid?: number | null
          assigned_consultant_id?: string | null
          attribution_priority?: Json | null
          auto_send_block_reason?: string | null
          auto_send_blocked_at?: string | null
          booked_at?: string | null
          booking_value?: number | null
          calendly_qa?: Json | null
          cancelled_at?: string | null
          ceremony_start?: string | null
          ceremony_start_confirmed_at?: string | null
          ceremony_start_confirmed_by?: string | null
          code_extension?: string | null
          confidence_flag?: string | null
          contracted_at?: string | null
          couple_invited_at?: string | null
          couple_photo_url?: string | null
          couple_registered_at?: string | null
          created_at?: string | null
          crm_external_id?: string | null
          crm_source?: string | null
          crm_team_members?: Json | null
          day_of_timeline_locked?: boolean
          day_of_timeline_locked_at?: string | null
          day_of_timeline_locked_by?: string | null
          deposit_amount?: number | null
          dietary_summary?: string | null
          estimated_guests?: number | null
          event_code?: string | null
          family_context?: string | null
          field_source?: Json
          first_response_at?: string | null
          first_touch_overridden_at?: string | null
          first_touch_overridden_by?: string | null
          friction_tags?: Json
          gratuity_amount?: number | null
          guest_count_estimate?: number | null
          guest_count_evidence?: Json
          guest_count_locked_at?: string | null
          guest_count_locked_by?: string | null
          guest_count_locked_by_operator?: boolean
          has_toured_in_person?: boolean
          has_toured_in_person_at?: string | null
          heat_recompute_pending?: boolean
          heat_score_overridden_at?: string | null
          heat_score_overridden_by?: string | null
          heat_score_override_value?: number | null
          hold_expires_at?: string | null
          id?: string
          import_warnings?: Json | null
          inquiry_date?: string | null
          inquiry_date_evidence?: Json
          inquiry_date_locked_at?: string | null
          inquiry_date_locked_by?: string | null
          inquiry_date_locked_by_operator?: boolean
          lead_source?: string | null
          lead_source_derivation_attempted_at?: string | null
          lifecycle_stage?: string | null
          lifecycle_stage_set_at?: string | null
          lifecycle_transition_count?: number
          lost_at?: string | null
          lost_locked_at?: string | null
          lost_locked_by?: string | null
          lost_locked_by_operator?: boolean
          lost_reason?: string | null
          merged_into_id?: string | null
          narrative_cache_busted_at?: string | null
          non_couple_at?: string | null
          non_couple_reason?: string | null
          notes?: string | null
          package?: string | null
          package_name?: string | null
          partner_count?: number | null
          persona_label?: string | null
          persona_label_overridden_at?: string | null
          persona_label_overridden_by?: string | null
          previous_wedding_id?: string | null
          quoted_value?: number | null
          raw_import_row?: Json | null
          reception_end?: string | null
          reception_end_confirmed_at?: string | null
          reception_end_confirmed_by?: string | null
          referred_by?: string | null
          refunded_amount?: number | null
          requested_date?: string | null
          sage_context_notes?: Json
          sms_scheduling_extracted_at?: string | null
          source?: string | null
          source_detail?: string | null
          source_evidence?: Json
          source_kind?: string | null
          source_locked_at?: string | null
          source_locked_by?: string | null
          source_locked_by_operator?: boolean
          source_provenance?: string | null
          source_records?: Json
          status?: string | null
          tax_amount?: number | null
          tour_date?: string | null
          updated_at?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_first_seen_at?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          venue_id: string
          wedding_date?: string | null
          wedding_date_evidence?: Json
          wedding_date_locked_at?: string | null
          wedding_date_locked_by?: string | null
          wedding_date_locked_by_operator?: boolean
          wedding_date_precision?: string | null
        }
        Update: {
          ai_opted_out?: boolean
          ai_opted_out_at?: string | null
          ai_opted_out_reason?: string | null
          amount_paid?: number | null
          assigned_consultant_id?: string | null
          attribution_priority?: Json | null
          auto_send_block_reason?: string | null
          auto_send_blocked_at?: string | null
          booked_at?: string | null
          booking_value?: number | null
          calendly_qa?: Json | null
          cancelled_at?: string | null
          ceremony_start?: string | null
          ceremony_start_confirmed_at?: string | null
          ceremony_start_confirmed_by?: string | null
          code_extension?: string | null
          confidence_flag?: string | null
          contracted_at?: string | null
          couple_invited_at?: string | null
          couple_photo_url?: string | null
          couple_registered_at?: string | null
          created_at?: string | null
          crm_external_id?: string | null
          crm_source?: string | null
          crm_team_members?: Json | null
          day_of_timeline_locked?: boolean
          day_of_timeline_locked_at?: string | null
          day_of_timeline_locked_by?: string | null
          deposit_amount?: number | null
          dietary_summary?: string | null
          estimated_guests?: number | null
          event_code?: string | null
          family_context?: string | null
          field_source?: Json
          first_response_at?: string | null
          first_touch_overridden_at?: string | null
          first_touch_overridden_by?: string | null
          friction_tags?: Json
          gratuity_amount?: number | null
          guest_count_estimate?: number | null
          guest_count_evidence?: Json
          guest_count_locked_at?: string | null
          guest_count_locked_by?: string | null
          guest_count_locked_by_operator?: boolean
          has_toured_in_person?: boolean
          has_toured_in_person_at?: string | null
          heat_recompute_pending?: boolean
          heat_score_overridden_at?: string | null
          heat_score_overridden_by?: string | null
          heat_score_override_value?: number | null
          hold_expires_at?: string | null
          id?: string
          import_warnings?: Json | null
          inquiry_date?: string | null
          inquiry_date_evidence?: Json
          inquiry_date_locked_at?: string | null
          inquiry_date_locked_by?: string | null
          inquiry_date_locked_by_operator?: boolean
          lead_source?: string | null
          lead_source_derivation_attempted_at?: string | null
          lifecycle_stage?: string | null
          lifecycle_stage_set_at?: string | null
          lifecycle_transition_count?: number
          lost_at?: string | null
          lost_locked_at?: string | null
          lost_locked_by?: string | null
          lost_locked_by_operator?: boolean
          lost_reason?: string | null
          merged_into_id?: string | null
          narrative_cache_busted_at?: string | null
          non_couple_at?: string | null
          non_couple_reason?: string | null
          notes?: string | null
          package?: string | null
          package_name?: string | null
          partner_count?: number | null
          persona_label?: string | null
          persona_label_overridden_at?: string | null
          persona_label_overridden_by?: string | null
          previous_wedding_id?: string | null
          quoted_value?: number | null
          raw_import_row?: Json | null
          reception_end?: string | null
          reception_end_confirmed_at?: string | null
          reception_end_confirmed_by?: string | null
          referred_by?: string | null
          refunded_amount?: number | null
          requested_date?: string | null
          sage_context_notes?: Json
          sms_scheduling_extracted_at?: string | null
          source?: string | null
          source_detail?: string | null
          source_evidence?: Json
          source_kind?: string | null
          source_locked_at?: string | null
          source_locked_by?: string | null
          source_locked_by_operator?: boolean
          source_provenance?: string | null
          source_records?: Json
          status?: string | null
          tax_amount?: number | null
          tour_date?: string | null
          updated_at?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_first_seen_at?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
          venue_id?: string
          wedding_date?: string | null
          wedding_date_evidence?: Json
          wedding_date_locked_at?: string | null
          wedding_date_locked_by?: string | null
          wedding_date_locked_by_operator?: boolean
          wedding_date_precision?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "weddings_assigned_consultant_id_fkey"
            columns: ["assigned_consultant_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_ceremony_start_confirmed_by_fkey"
            columns: ["ceremony_start_confirmed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_day_of_timeline_locked_by_fkey"
            columns: ["day_of_timeline_locked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_first_touch_overridden_by_fkey"
            columns: ["first_touch_overridden_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_guest_count_locked_by_fkey"
            columns: ["guest_count_locked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_heat_score_overridden_by_fkey"
            columns: ["heat_score_overridden_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_inquiry_date_locked_by_fkey"
            columns: ["inquiry_date_locked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_lost_locked_by_fkey"
            columns: ["lost_locked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "weddings_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_persona_label_overridden_by_fkey"
            columns: ["persona_label_overridden_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_previous_wedding_id_fkey"
            columns: ["previous_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "weddings_previous_wedding_id_fkey"
            columns: ["previous_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_reception_end_confirmed_by_fkey"
            columns: ["reception_end_confirmed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_source_locked_by_fkey"
            columns: ["source_locked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weddings_wedding_date_locked_by_fkey"
            columns: ["wedding_date_locked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      zoom_connections: {
        Row: {
          access_token: string
          account_email: string | null
          created_at: string | null
          expires_at: string
          id: string
          is_active: boolean | null
          last_synced_at: string | null
          refresh_token: string
          scope: string | null
          updated_at: string | null
          venue_id: string
          zoom_user_id: string
        }
        Insert: {
          access_token: string
          account_email?: string | null
          created_at?: string | null
          expires_at: string
          id?: string
          is_active?: boolean | null
          last_synced_at?: string | null
          refresh_token: string
          scope?: string | null
          updated_at?: string | null
          venue_id: string
          zoom_user_id: string
        }
        Update: {
          access_token?: string
          account_email?: string | null
          created_at?: string | null
          expires_at?: string
          id?: string
          is_active?: boolean | null
          last_synced_at?: string | null
          refresh_token?: string
          scope?: string | null
          updated_at?: string | null
          venue_id?: string
          zoom_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "zoom_connections_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      zoom_webhook_log: {
        Row: {
          created_at: string | null
          duration_minutes: number | null
          event_type: string | null
          host_email: string | null
          id: string
          interaction_id: string | null
          meeting_uuid: string
          processed_at: string | null
          raw_payload: Json | null
          recording_url: string | null
          start_time: string | null
          topic: string | null
          transcript_url: string | null
          venue_id: string | null
        }
        Insert: {
          created_at?: string | null
          duration_minutes?: number | null
          event_type?: string | null
          host_email?: string | null
          id?: string
          interaction_id?: string | null
          meeting_uuid: string
          processed_at?: string | null
          raw_payload?: Json | null
          recording_url?: string | null
          start_time?: string | null
          topic?: string | null
          transcript_url?: string | null
          venue_id?: string | null
        }
        Update: {
          created_at?: string | null
          duration_minutes?: number | null
          event_type?: string | null
          host_email?: string | null
          id?: string
          interaction_id?: string | null
          meeting_uuid?: string
          processed_at?: string | null
          raw_payload?: Json | null
          recording_url?: string | null
          start_time?: string | null
          topic?: string | null
          transcript_url?: string | null
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "zoom_webhook_log_interaction_id_fkey"
            columns: ["interaction_id"]
            isOneToOne: false
            referencedRelation: "interactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zoom_webhook_log_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      attribution_events_live: {
        Row: {
          bucket: string | null
          candidate_identity_id: string | null
          confidence: number | null
          conflict_resolution_state: string | null
          conflict_resolved_at: string | null
          conflict_resolved_by: string | null
          conflict_with_legacy_source: string | null
          created_at: string | null
          decided_at: string | null
          decided_by: string | null
          id: string | null
          intent_class:
            | Database["public"]["Enums"]["attribution_intent_class"]
            | null
          intent_class_confidence_0_100: number | null
          intent_class_signals: Json | null
          intent_classified_at: string | null
          is_first_touch: boolean | null
          persona_overlay: Json | null
          prompt_version_classified_under: string | null
          reasoning: string | null
          referral_resolved_at: string | null
          referrer_confidence_0_100: number | null
          referrer_evidence_quote: string | null
          referrer_name_text: string | null
          referrer_relationship_text: string | null
          referrer_wedding_id: string | null
          reverted_at: string | null
          reverted_by: string | null
          reverted_reason: string | null
          role: Database["public"]["Enums"]["attribution_role"] | null
          role_classified_at: string | null
          role_confidence_0_100: number | null
          role_evidence: Json | null
          role_reasoning: string | null
          signal_class: string | null
          signal_id: string | null
          source_platform: string | null
          tier: string | null
          tombstoned_at: string | null
          venue_id: string | null
          wedding_id: string | null
        }
        Insert: {
          bucket?: string | null
          candidate_identity_id?: string | null
          confidence?: number | null
          conflict_resolution_state?: string | null
          conflict_resolved_at?: string | null
          conflict_resolved_by?: string | null
          conflict_with_legacy_source?: string | null
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string | null
          intent_class?:
            | Database["public"]["Enums"]["attribution_intent_class"]
            | null
          intent_class_confidence_0_100?: number | null
          intent_class_signals?: Json | null
          intent_classified_at?: string | null
          is_first_touch?: boolean | null
          persona_overlay?: Json | null
          prompt_version_classified_under?: string | null
          reasoning?: string | null
          referral_resolved_at?: string | null
          referrer_confidence_0_100?: number | null
          referrer_evidence_quote?: string | null
          referrer_name_text?: string | null
          referrer_relationship_text?: string | null
          referrer_wedding_id?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          reverted_reason?: string | null
          role?: Database["public"]["Enums"]["attribution_role"] | null
          role_classified_at?: string | null
          role_confidence_0_100?: number | null
          role_evidence?: Json | null
          role_reasoning?: string | null
          signal_class?: string | null
          signal_id?: string | null
          source_platform?: string | null
          tier?: string | null
          tombstoned_at?: string | null
          venue_id?: string | null
          wedding_id?: string | null
        }
        Update: {
          bucket?: string | null
          candidate_identity_id?: string | null
          confidence?: number | null
          conflict_resolution_state?: string | null
          conflict_resolved_at?: string | null
          conflict_resolved_by?: string | null
          conflict_with_legacy_source?: string | null
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string | null
          intent_class?:
            | Database["public"]["Enums"]["attribution_intent_class"]
            | null
          intent_class_confidence_0_100?: number | null
          intent_class_signals?: Json | null
          intent_classified_at?: string | null
          is_first_touch?: boolean | null
          persona_overlay?: Json | null
          prompt_version_classified_under?: string | null
          reasoning?: string | null
          referral_resolved_at?: string | null
          referrer_confidence_0_100?: number | null
          referrer_evidence_quote?: string | null
          referrer_name_text?: string | null
          referrer_relationship_text?: string | null
          referrer_wedding_id?: string | null
          reverted_at?: string | null
          reverted_by?: string | null
          reverted_reason?: string | null
          role?: Database["public"]["Enums"]["attribution_role"] | null
          role_classified_at?: string | null
          role_confidence_0_100?: number | null
          role_evidence?: Json | null
          role_reasoning?: string | null
          signal_class?: string | null
          signal_id?: string | null
          source_platform?: string | null
          tier?: string | null
          tombstoned_at?: string | null
          venue_id?: string | null
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attribution_events_candidate_identity_id_fkey"
            columns: ["candidate_identity_id"]
            isOneToOne: false
            referencedRelation: "candidate_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_referrer_wedding_id_fkey"
            columns: ["referrer_wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "attribution_events_referrer_wedding_id_fkey"
            columns: ["referrer_wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_reverted_by_fkey"
            columns: ["reverted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "tangential_signals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attribution_events_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "attribution_events_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_heat: {
        Row: {
          cohort_booked: number | null
          cohort_booking_rate: number | null
          cohort_multiplier: number | null
          cohort_signature: string | null
          cohort_size: number | null
          heat_score: number | null
          is_overridden: boolean | null
          raw_score: number | null
          temperature_tier: string | null
          venue_id: string | null
          wedding_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "weddings_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      wedding_touchpoints_live: {
        Row: {
          campaign: string | null
          created_at: string | null
          id: string | null
          medium: string | null
          metadata: Json | null
          occurred_at: string | null
          signal_class: string | null
          signal_id: string | null
          source: string | null
          touch_type: string | null
          venue_id: string | null
          wedding_id: string | null
        }
        Insert: {
          campaign?: string | null
          created_at?: string | null
          id?: string | null
          medium?: string | null
          metadata?: Json | null
          occurred_at?: string | null
          signal_class?: string | null
          signal_id?: string | null
          source?: string | null
          touch_type?: string | null
          venue_id?: string | null
          wedding_id?: string | null
        }
        Update: {
          campaign?: string | null
          created_at?: string | null
          id?: string | null
          medium?: string | null
          metadata?: Json | null
          occurred_at?: string | null
          signal_class?: string | null
          signal_id?: string | null
          source?: string | null
          touch_type?: string | null
          venue_id?: string | null
          wedding_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wedding_touchpoints_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wedding_touchpoints_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "wedding_heat"
            referencedColumns: ["wedding_id"]
          },
          {
            foreignKeyName: "wedding_touchpoints_wedding_id_fkey"
            columns: ["wedding_id"]
            isOneToOne: false
            referencedRelation: "weddings"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _list_wedding_fk_columns: { Args: never; Returns: Json }
      append_tour_transcript: {
        Args: {
          p_received_at: string
          p_text: string
          p_tour_id: string
          p_venue_id: string
        }
        Returns: undefined
      }
      can_access_venue: { Args: { p_venue_id: string }; Returns: boolean }
      can_access_wedding: { Args: { p_wedding_id: string }; Returns: boolean }
      check_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_sec: number }
        Returns: {
          allowed: boolean
          remaining: number
          reset_at: string
        }[]
      }
      compute_couple_display_name: {
        Args: { p_wedding_id: string }
        Returns: string
      }
      couple_user_venue_id: { Args: never; Returns: string }
      couple_user_wedding_id: { Args: never; Returns: string }
      demo_visible_venue_ids: { Args: never; Returns: string[] }
      exec_sql: { Args: { sql: string }; Returns: Json }
      get_org_id_for_user: { Args: never; Returns: string }
      get_venue_id_for_user: { Args: never; Returns: string }
      is_demo_venue: { Args: { p_venue_id: string }; Returns: boolean }
      is_demo_wedding: { Args: { p_wedding_id: string }; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      lock_and_mint_couple: {
        Args: {
          p_action_type: string
          p_channel: string
          p_channel_scope: string
          p_external_id: string
          p_lock_key: string
          p_occurred_at: string
          p_partner_email: string
          p_partner_name: string
          p_partner_phone: string
          p_primary_email: string
          p_primary_name: string
          p_primary_phone: string
          p_raw_payload: Json
          p_signal_tier: string
          p_venue_id: string
          p_wedding_date: string
        }
        Returns: {
          couple_id: string
          minted: boolean
          touchpoint_id: string
          touchpoint_inserted: boolean
        }[]
      }
      merge_couples: {
        Args: {
          p_loser: string
          p_reason: string
          p_rule?: string
          p_winner: string
        }
        Returns: boolean
      }
      normalise_e164: { Args: { p_raw: string }; Returns: string }
      prune_rate_limit_buckets: { Args: never; Returns: number }
      relink_orphan_interactions: {
        Args: { p_venue_id: string }
        Returns: Json
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      sync_venue_availability_for_date: {
        Args: { p_date: string; p_venue_id: string }
        Returns: undefined
      }
      try_uuid: { Args: { p_text: string }; Returns: string }
      upsert_orphan_transcript: {
        Args: {
          p_audio_provider: string
          p_last_segment_at: string
          p_segments_count_delta: number
          p_session_id: string
          p_text: string
          p_venue_id: string
        }
        Returns: string
      }
      user_visible_venue_ids: { Args: never; Returns: string[] }
    }
    Enums: {
      attribution_intent_class:
        | "targeted"
        | "broadcast"
        | "validation"
        | "unknown"
      attribution_role:
        | "acquisition"
        | "validation"
        | "conversion"
        | "mixed"
        | "unknown"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      attribution_intent_class: [
        "targeted",
        "broadcast",
        "validation",
        "unknown",
      ],
      attribution_role: [
        "acquisition",
        "validation",
        "conversion",
        "mixed",
        "unknown",
      ],
    },
  },
} as const
