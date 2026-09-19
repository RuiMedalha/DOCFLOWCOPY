import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Termos de Serviço — DocFlow',
  description: 'Termos e Condições de Utilização da plataforma DocFlow.',
};

export default function TermsPage() {
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
            Termos de Serviço
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
              1. Objeto e Âmbito
            </h2>
            <p>
              Os presentes Termos de Serviço regulam o acesso e utilização da plataforma DocFlow,
              uma solução de inteligência documental, conciliação e gestão para empresas e profissionais.
              Ao aceder ou utilizar o serviço, concorda em cumprir integralmente estes termos.
            </p>
          </section>

          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              2. Registo e Segurança da Conta
            </h2>
            <p>
              O utilizador é responsável por manter a confidencialidade das suas credenciais de acesso
              e por todas as atividades realizadas na sua conta. Compromete-se a notificar de imediato
              a DocFlow em caso de qualquer utilização não autorizada.
            </p>
          </section>

          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              3. Propriedade dos Dados e Documentos
            </h2>
            <p>
              Todos os documentos, faturas e ficheiros submetidos pelo utilizador permanecem de sua
              exclusiva propriedade. A DocFlow apenas processa e extrai informação com a finalidade
              estrita de prestar os serviços contratados, em conformidade com as obrigações legais
              aplicáveis e o Regulamento Geral sobre a Proteção de Dados (RGPD).
            </p>
          </section>

          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              4. Disponibilidade do Serviço
            </h2>
            <p>
              Empenhamo-nos em manter o serviço permanentemente disponível, salvaguardando períodos de
              manutenção planeada ou indisponibilidades de força maior. A DocFlow não garante que a
              plataforma esteja isenta de erros temporários ou interrupções.
            </p>
          </section>

          <section>
            <h2
              className="text-base font-semibold mb-2"
              style={{ color: 'var(--text-primary, #f1f5f9)' }}
            >
              5. Contacto
            </h2>
            <p>
              Para esclarecimento de dúvidas sobre os Termos de Serviço, contacte o nosso suporte
              através de <a href="mailto:suporte@docflow.pt" className="underline hover:opacity-80">suporte@docflow.pt</a>.
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
          <Link href="/legal/privacy" className="underline hover:opacity-80">
            Política de Privacidade
          </Link>
        </footer>
      </div>
    </main>
  );
}
