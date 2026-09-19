import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Política de Privacidade — DocFlow',
  description: 'Política de Privacidade e Proteção de Dados da plataforma DocFlow.',
};

export default function PrivacyPage() {
  return (
    <main
      className="min-h-screen py-16 px-4 sm:px-6 lg:px-8"
      style={{
        backgroundColor: 'var(--bg-canvas, #070b14)',
        color: 'var(--text-primary, #f1f5f9)',
      }}
    >
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <Link
            href="/"
            className="text-xs uppercase tracking-wider font-semibold transition-opacity hover:opacity-80"
            style={{ color: 'var(--text-muted, #94a3b8)' }}
          >
            ← Voltar
          </Link>
          <h1
            className="mt-4 text-3xl sm:text-4xl font-semibold tracking-tight"
            style={{ fontFamily: 'var(--font-editorial, serif)' }}
          >
            Política de Privacidade
          </h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted, #94a3b8)' }}>
            Última atualização: 10 de setembro de 2026
          </p>
        </div>

        <article
          className="space-y-6 text-sm leading-relaxed"
          style={{ color: 'var(--text-secondary, #cbd5e1)' }}
        >
          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              1. Enquadramento e Responsável pelo Tratamento
            </h2>
            <p>
              A DocFlow assume o compromisso de proteger a privacidade e os dados pessoais dos seus utilizadores,
              em estrita conformidade com o Regulamento Geral sobre a Proteção de Dados (RGPD - Regulamento UE 2016/679)
              e com a Lei n.º 58/2019 de 8 de agosto.
            </p>
          </section>

          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              2. Dados Recolhidos e Finalidade
            </h2>
            <p>
              Recolhemos dados de identificação (nome, email, NIF, cargo) e dados de faturação para a gestão da conta,
              prestação do serviço, cumprimento de obrigações fiscais e prevenção de fraude. Os documentos submetidos
              são processados exclusivamente para extração e organização conforme solicitado pelo utilizador.
            </p>
          </section>

          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              3. Armazenamento e Segurança
            </h2>
            <p>
              Todos os dados e ficheiros são armazenados em servidores seguros na União Europeia, protegidos por
              encriptação em trânsito (TLS) e em repouso (AES-256), com controlos rígidos de acesso e registos de auditoria.
            </p>
          </section>

          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              4. Direitos do Titular dos Dados
            </h2>
            <p>
              Nos termos da lei aplicável, o titular dos dados tem direito a solicitar o acesso, retificação,
              apagamento, limitação do tratamento ou portabilidade dos seus dados pessoais, bem como a opor-se ao
              tratamento ou apresentar reclamação à CNPD (Comissão Nacional de Proteção de Dados).
            </p>
          </section>

          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              5. Contacto do Encarregado de Proteção de Dados
            </h2>
            <p>
              Para o exercício de qualquer direito ou dúvidas sobre privacidade, contacte-nos através do endereço{' '}
              <a href="mailto:dpo@docflow.pt" className="underline hover:opacity-80">
                dpo@docflow.pt
              </a>
              .
            </p>
          </section>
        </article>

        <footer
          className="mt-12 pt-6 border-t text-xs flex justify-between items-center"
          style={{
            borderColor: 'var(--border-subtle, #1e293b)',
            color: 'var(--text-muted, #94a3b8)',
          }}
        >
          <span>© {new Date().getFullYear()} DocFlow. Todos os direitos reservados.</span>
          <Link href="/legal/terms" className="underline hover:opacity-80">
            Termos de Serviço
          </Link>
        </footer>
      </div>
    </main>
  );
}
