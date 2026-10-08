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
  public: {
    Tables: {
      app_comments: {
        Row: {
          app_id: string
          content: string
          created_at: string
          id: string
          user_hash: string
        }
        Insert: {
          app_id: string
          content: string
          created_at?: string
          id?: string
          user_hash: string
        }
        Update: {
          app_id?: string
          content?: string
          created_at?: string
          id?: string
          user_hash?: string
        }
        Relationships: []
      }
      app_ratings: {
        Row: {
          app_id: string
          created_at: string
          id: string
          rating: number
          updated_at: string
          user_hash: string
        }
        Insert: {
          app_id: string
          created_at?: string
          id?: string
          rating: number
          updated_at?: string
          user_hash: string
        }
        Update: {
          app_id?: string
          created_at?: string
          id?: string
          rating?: number
          updated_at?: string
          user_hash?: string
        }
        Relationships: []
      }
      lcm_data_reset_configs: {
        Row: {
          created_at: string
          destination_api_key: string
          destination_client_ids: Json
          destination_client_names: Json
          id: string
          last_run_at: string | null
          last_run_status: string | null
          last_run_summary: Json | null
          name: string
          schedule_enabled: boolean
          selected_objects: Json
          source_client_id: string
          source_client_name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          destination_api_key: string
          destination_client_ids?: Json
          destination_client_names?: Json
          id?: string
          last_run_at?: string | null
          last_run_status?: string | null
          last_run_summary?: Json | null
          name?: string
          schedule_enabled?: boolean
          selected_objects?: Json
          source_client_id: string
          source_client_name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          destination_api_key?: string
          destination_client_ids?: Json
          destination_client_names?: Json
          id?: string
          last_run_at?: string | null
          last_run_status?: string | null
          last_run_summary?: Json | null
          name?: string
          schedule_enabled?: boolean
          selected_objects?: Json
          source_client_id?: string
          source_client_name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      lcm_data_reset_runs: {
        Row: {
          config_id: string
          details: Json | null
          error_message: string | null
          finished_at: string | null
          id: string
          started_at: string
          status: string
          total_created: number
          total_deleted: number
          total_failures: number
          trigger_type: string
          user_id: string
        }
        Insert: {
          config_id: string
          details?: Json | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          status: string
          total_created?: number
          total_deleted?: number
          total_failures?: number
          trigger_type: string
          user_id: string
        }
        Update: {
          config_id?: string
          details?: Json | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          status?: string
          total_created?: number
          total_deleted?: number
          total_failures?: number
          trigger_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lcm_data_reset_runs_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "lcm_data_reset_configs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
  public: {
    Enums: {},
  },
} as const
